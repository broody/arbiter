use referee::channel::{
    ACTIVE, DISPUTE, FORCED, PAUSE_SECONDS, SETTLED, acknowledge, claim_timeout, forced,
    open as open_channel, open_dispute, receive, resign, resolve, resume, rolled, void,
};
use referee::{
    Channel, DRAW, Envelope, Move, REASON_ABANDON, REASON_RESIGN, REASON_VOID, REFEREE, StateRef,
    force, open, replay, state_ref,
};
use crate::fixtures::{CONTEXT, expected, finals, steps, terms};
use crate::tests::batch;
use crate::{ADD, Action, Counter, CounterRules};

const WINDOW: u32 = 3600;
const T0: u64 = 1000;

fn opening() -> Envelope<Counter> {
    open::<CounterRules>(@terms())
}

/// State after the first `n` signed fixture steps.
fn after(n: u32) -> StateRef {
    let end = replay::<
        CounterRules,
    >(CONTEXT, @terms(), opening(), (), batch(steps().span().slice(0, n), finals(0, n).span()));
    state_ref::<CounterRules>(@end)
}

fn finished() -> StateRef {
    state_ref::<CounterRules>(@expected())
}

fn active() -> Channel {
    open_channel(CONTEXT, state_ref::<CounterRules>(@opening()), WINDOW, false, 10)
}

/// Dispute opened from the opening anchor and resolved into forced play.
fn forced_play() -> Channel {
    let channel = open_dispute(active(), 0, T0);
    resolve(channel, 0, T0 + WINDOW.into(), 20, false)
}

#[test]
fn a_channel_opens_live_at_the_opening_state() {
    let channel = active();
    assert_eq!(channel.status, ACTIVE);
    assert_eq!(channel.epoch, 0);
    assert_eq!(channel.context, CONTEXT);
    assert_eq!(channel.anchor, state_ref::<CounterRules>(@opening()));
    assert_eq!(channel.candidate, channel.anchor);
    assert_eq!(channel.anchor_block, 10);
    assert_eq!(channel.anchor.due, 0);
}

#[test]
#[should_panic(expected: 'Invalid response window')]
fn response_window_is_bounded() {
    open_channel(CONTEXT, state_ref::<CounterRules>(@opening()), 299, false, 10);
}

#[test]
#[should_panic(expected: 'Invalid context')]
fn a_channel_needs_a_context() {
    open_channel(0, state_ref::<CounterRules>(@opening()), WINDOW, false, 10);
}

#[test]
#[should_panic(expected: 'Invalid opening state')]
fn a_channel_opens_only_at_an_opening_state() {
    open_channel(CONTEXT, after(1), WINDOW, false, 10);
}

#[test]
fn approved_final_state_settles_at_once() {
    let channel = receive(active(), 0, finished(), true, T0, 20);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.epoch, 1);
    assert_eq!(channel.anchor, finished());
    assert_eq!(channel.result, expected().outcome);
    assert_eq!(channel.anchor_block, 20);
}

#[test]
fn approved_checkpoint_keeps_playing() {
    let channel = receive(active(), 0, after(4), true, T0, 20);
    assert_eq!(channel.status, ACTIVE);
    assert_eq!(channel.epoch, 1);
    // The next checkpoint builds on the new anchor with the new epoch.
    let channel = receive(channel, 1, finished(), true, T0 + 5, 30);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.epoch, 2);
}

#[test]
fn unapproved_final_state_settles_after_the_window() {
    let channel = receive(active(), 0, finished(), false, T0, 20);
    assert_eq!(channel.status, DISPUTE);
    assert_eq!(channel.deadline, T0 + WINDOW.into());
    assert_eq!(channel.epoch, 0);
    let channel = resolve(channel, 0, T0 + WINDOW.into(), 30, false);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.result, expected().outcome);
}

#[test]
#[should_panic(expected: 'Dispute window open')]
fn resolve_waits_for_the_window() {
    let channel = receive(active(), 0, finished(), false, T0, 20);
    resolve(channel, 0, T0 + WINDOW.into() - 1, 30, false);
}

#[test]
fn newer_candidate_replaces_without_extending_the_deadline() {
    let channel = receive(active(), 0, after(4), false, T0, 20);
    let channel = receive(channel, 0, after(6), false, T0 + 100, 21);
    assert_eq!(channel.candidate, after(6));
    assert_eq!(channel.candidate_block, 21);
    assert_eq!(channel.deadline, T0 + WINDOW.into());
    assert_eq!(channel.anchor, state_ref::<CounterRules>(@opening()));
    assert_eq!(channel.anchor_block, 10);
}

#[test]
#[should_panic(expected: 'Not a newer candidate')]
fn older_candidate_rejected() {
    let channel = receive(active(), 0, after(6), false, T0, 20);
    receive(channel, 0, after(4), false, T0 + 1, 21);
}

#[test]
#[should_panic(expected: 'Older than candidate')]
fn approval_cannot_undercut_a_better_supported_candidate() {
    let channel = receive(active(), 0, after(6), false, T0, 20);
    receive(channel, 0, after(4), true, T0 + 1, 21);
}

#[test]
#[should_panic(expected: 'Dispute window closed')]
fn no_candidates_after_the_window() {
    let channel = receive(active(), 0, after(4), false, T0, 20);
    receive(channel, 0, after(6), false, T0 + WINDOW.into(), 21);
}

#[test]
#[should_panic(expected: 'Stale channel epoch')]
fn stale_epoch_rejected() {
    receive(active(), 1, after(4), false, T0, 20);
}

#[test]
fn unfinished_dispute_moves_to_forced_play() {
    let channel = forced_play();
    assert_eq!(channel.status, FORCED);
    assert_eq!(channel.epoch, 1);
    assert_eq!(channel.anchor.due, 0);
    assert_eq!(channel.deadline, T0 + 2 * WINDOW.into());
}

#[test]
fn due_seat_plays_onchain_and_waiting_seat_claims_timeout() {
    // Seat 0 plays its forced step exactly as `protocol::force` computes it.
    let steps = array![Move::Play(Action { kind: ADD, amount: 3 })];
    let env = force::<CounterRules>(CONTEXT, @terms(), opening(), (), 0, steps.span());
    let end = state_ref::<CounterRules>(@env);
    // Unsigned forced steps extend the transcript exactly like signed ones.
    assert_eq!(end, after(1));

    let now = T0 + WINDOW.into() + 5;
    let channel = forced(forced_play(), 1, 0, end, now, 30);
    assert_eq!(channel.status, FORCED);
    assert_eq!(channel.epoch, 2);
    assert_eq!(channel.anchor.due, 1);
    assert_eq!(channel.deadline, now + WINDOW.into());

    // Seat 1 never answers.
    let channel = claim_timeout(channel, 2, 0, now + WINDOW.into());
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.result.winner, 1); // seat 0 + 1
    // The chain judged it, not a referee.
    assert_eq!(channel.result.reason, REASON_ABANDON);
}

#[test]
#[should_panic(expected: 'Not your turn')]
fn waiting_seat_cannot_play_forced() {
    forced(forced_play(), 1, 1, after(1), T0 + WINDOW.into() + 5, 30);
}

#[test]
#[should_panic(expected: 'Turn deadline passed')]
fn forced_play_after_the_deadline_rejected() {
    forced(forced_play(), 1, 0, after(1), T0 + 2 * WINDOW.into(), 30);
}

#[test]
#[should_panic(expected: 'Only waiting seat')]
fn due_seat_cannot_claim_timeout() {
    claim_timeout(forced_play(), 1, 0, T0 + 2 * WINDOW.into());
}

#[test]
#[should_panic(expected: 'Turn window open')]
fn timeout_waits_for_the_deadline() {
    claim_timeout(forced_play(), 1, 1, T0 + 2 * WINDOW.into() - 1);
}

#[test]
fn every_seat_can_resume_offchain_play() {
    let channel = resume(forced_play(), 1, true, T0 + WINDOW.into() + 5, 40);
    assert_eq!(channel.status, ACTIVE);
    assert_eq!(channel.epoch, 2);
    assert_eq!(channel.deadline, 0);
    assert_eq!(channel.anchor_block, 40);
}

#[test]
#[should_panic(expected: 'Need every approval')]
fn resume_needs_every_approval() {
    resume(forced_play(), 1, false, T0 + WINDOW.into() + 5, 40);
}

#[test]
fn resign_settles_for_the_other_seat() {
    let channel = resign(active(), 0);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.result.winner, 2); // seat 1 + 1
    assert_eq!(channel.result.reason, REASON_RESIGN);
    // Also allowed during a dispute and in forced play.
    assert_eq!(resign(receive(active(), 0, after(4), false, T0, 20), 1).result.winner, 1);
    assert_eq!(resign(forced_play(), 1).status, SETTLED);
}

#[test]
#[should_panic(expected: 'Channel not live')]
fn cannot_resign_a_settled_channel() {
    resign(resign(active(), 0), 1);
}

/// A timed game's dispute that its referee acknowledged.
fn acknowledged() -> Channel {
    acknowledge(open_dispute(active(), 0, T0), 0, T0 + 10)
}

#[test]
fn acknowledged_timed_dispute_returns_to_offchain_play() {
    let channel = acknowledged();
    assert_eq!(channel.acked_epoch, 0);
    assert_eq!(channel.acked_deadline, T0 + WINDOW.into());
    let channel = resolve(channel, 0, T0 + WINDOW.into(), 20, true);
    assert_eq!(channel.status, ACTIVE);
    assert_eq!(channel.epoch, 1);
    assert_eq!(channel.deadline, 0);
    assert_eq!(channel.anchor_block, 20);
    assert_eq!(channel.candidate_block, 20);
}

#[test]
fn acknowledged_dispute_keeps_its_candidate() {
    let channel = acknowledge(receive(active(), 0, after(4), false, T0, 20), 0, T0 + 10);
    let channel = resolve(channel, 0, T0 + WINDOW.into(), 30, true);
    assert_eq!(channel.status, ACTIVE);
    assert_eq!(channel.anchor, after(4));
}

#[test]
fn acknowledged_finished_candidate_settles() {
    let channel = acknowledge(receive(active(), 0, finished(), false, T0, 20), 0, T0 + 10);
    assert_eq!(resolve(channel, 0, T0 + WINDOW.into(), 30, true).status, SETTLED);
}

#[test]
fn untimed_dispute_ignores_an_acknowledgement() {
    // Only a game with a referee clock returns to offchain play.
    assert_eq!(resolve(acknowledged(), 0, T0 + WINDOW.into(), 20, false).status, FORCED);
}

#[test]
fn unacknowledged_timed_dispute_moves_to_forced_play() {
    let channel = open_dispute(active(), 0, T0);
    assert_eq!(resolve(channel, 0, T0 + WINDOW.into(), 20, true).status, FORCED);
}

#[test]
fn an_acknowledgement_covers_only_its_dispute() {
    // Acknowledged at epoch 0, resolved back to offchain play, then disputed
    // again at epoch 1: the old acknowledgement doesn't carry over.
    let channel = resolve(acknowledged(), 0, T0 + WINDOW.into(), 20, true);
    let later = T0 + 2 * WINDOW.into();
    let channel = open_dispute(channel, 1, later);
    assert_eq!(resolve(channel, 1, later + WINDOW.into(), 30, true).status, FORCED);
}

#[test]
#[should_panic(expected: 'Dispute window closed')]
fn acknowledgement_must_land_in_the_window() {
    acknowledge(open_dispute(active(), 0, T0), 0, T0 + WINDOW.into());
}

#[test]
#[should_panic(expected: 'No dispute')]
fn acknowledgement_needs_a_dispute() {
    acknowledge(active(), 0, T0);
}

#[test]
#[should_panic(expected: 'Stale channel epoch')]
fn acknowledgement_names_the_epoch() {
    acknowledge(open_dispute(active(), 0, T0), 1, T0 + 10);
}

// ---- A roll that waits for the referee ----

/// State `n`, as if its last step had asked the referee for randomness.
fn awaiting_roll(n: u32) -> StateRef {
    StateRef { due: REFEREE, ..after(n) }
}

const FORCED_AT: u64 = T0 + 3600 + 5;

/// Forced play in which seat 0's step asked the referee for a roll.
fn paused() -> Channel {
    forced(forced_play(), 1, 0, awaiting_roll(1), FORCED_AT, 30)
}

#[test]
fn a_forced_request_pauses_for_the_referee() {
    let channel = paused();
    assert_eq!(channel.status, FORCED);
    assert_eq!(channel.anchor.due, REFEREE);
    // Three days, not the seats' response window.
    assert_eq!(channel.deadline, FORCED_AT + PAUSE_SECONDS);
}

#[test]
fn a_dispute_resolved_into_a_pending_roll_pauses() {
    let channel = receive(active(), 0, awaiting_roll(2), false, T0, 20);
    let channel = resolve(channel, 0, T0 + WINDOW.into(), 30, true);
    assert_eq!(channel.status, FORCED);
    assert_eq!(channel.deadline, T0 + WINDOW.into() + PAUSE_SECONDS);
}

#[test]
#[should_panic(expected: 'Waiting for the referee')]
fn nobody_times_out_while_the_referee_owes_a_roll() {
    claim_timeout(paused(), 2, 1, FORCED_AT + PAUSE_SECONDS);
}

#[test]
#[should_panic(expected: 'Not your turn')]
fn no_seat_plays_while_the_referee_owes_a_roll() {
    forced(paused(), 2, 1, after(2), FORCED_AT + 10, 40);
}

#[test]
fn a_posted_roll_restarts_the_window() {
    let now = FORCED_AT + 86400;
    let channel = rolled(paused(), 2, after(2), now, 40);
    assert_eq!(channel.status, FORCED);
    assert_eq!(channel.epoch, 3);
    assert_eq!(channel.anchor, after(2));
    assert_eq!(channel.deadline, now + WINDOW.into());
}

#[test]
fn a_posted_roll_can_end_the_game() {
    let channel = rolled(paused(), 2, finished(), FORCED_AT + 10, 40);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.result, finished().outcome);
}

#[test]
#[should_panic(expected: 'No roll due')]
fn a_roll_needs_a_request() {
    rolled(forced_play(), 1, after(1), T0 + WINDOW.into() + 5, 30);
}

#[test]
#[should_panic(expected: 'Turn deadline passed')]
fn a_roll_after_the_pause_is_too_late() {
    rolled(paused(), 2, after(2), FORCED_AT + PAUSE_SECONDS, 40);
}

#[test]
fn a_pause_ends_void_after_three_days() {
    let channel = void(paused(), 2, false, FORCED_AT + PAUSE_SECONDS);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.epoch, 3);
    // No result: the reason says so, whatever the winner field holds.
    assert_eq!(channel.result.reason, REASON_VOID);
    assert_eq!(channel.result.winner, DRAW);
}

#[test]
#[should_panic(expected: 'Pause still open')]
fn a_pause_is_not_voided_early() {
    void(paused(), 2, false, FORCED_AT + PAUSE_SECONDS - 1);
}

#[test]
fn every_seat_can_void_a_pause_at_once() {
    let channel = void(paused(), 2, true, FORCED_AT + 1);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.result.reason, REASON_VOID);
}

#[test]
#[should_panic(expected: 'No roll due')]
fn only_a_pending_roll_is_voided() {
    void(forced_play(), 1, true, T0 + WINDOW.into() + 5);
}

#[test]
fn a_paused_game_can_resume_offchain() {
    // The referee is back (or every seat agrees): it rolls offchain.
    let channel = resume(paused(), 2, true, FORCED_AT + 86400, 40);
    assert_eq!(channel.status, ACTIVE);
    assert_eq!(channel.anchor.due, REFEREE);
}
