use referee::channel::{
    ACTIVE, CANCELLED, DISPUTE, FORCED, SETTLED, WAITING, cancel, claim_timeout, create, forced,
    join, open_dispute, receive, resign, resolve, resume,
};
use referee::{
    Channel, Envelope, Move, REASON_RESIGN, REASON_TIMEOUT, StateRef, force, open, replay,
    state_ref,
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
    join(create(WINDOW), CONTEXT, state_ref::<CounterRules>(@opening()), 10)
}

/// Dispute opened from the opening anchor and resolved into forced play.
fn forced_play() -> Channel {
    let channel = open_dispute(active(), 0, T0);
    resolve(channel, 0, T0 + WINDOW.into(), 20)
}

#[test]
fn lifecycle_starts_waiting_then_active() {
    let channel = create(WINDOW);
    assert_eq!(channel.status, WAITING);
    let channel = active();
    assert_eq!(channel.status, ACTIVE);
    assert_eq!(channel.anchor, state_ref::<CounterRules>(@opening()));
    assert_eq!(channel.anchor.due, 0);
    assert_eq!(cancel(create(WINDOW)).status, CANCELLED);
}

#[test]
#[should_panic(expected: 'Not waiting')]
fn join_only_once() {
    join(active(), CONTEXT, state_ref::<CounterRules>(@opening()), 11);
}

#[test]
#[should_panic(expected: 'Invalid response window')]
fn response_window_is_bounded() {
    create(299);
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
    let channel = resolve(channel, 0, T0 + WINDOW.into(), 30);
    assert_eq!(channel.status, SETTLED);
    assert_eq!(channel.result, expected().outcome);
}

#[test]
#[should_panic(expected: 'Dispute window open')]
fn resolve_waits_for_the_window() {
    let channel = receive(active(), 0, finished(), false, T0, 20);
    resolve(channel, 0, T0 + WINDOW.into() - 1, 30);
}

#[test]
fn newer_candidate_replaces_without_extending_the_deadline() {
    let channel = receive(active(), 0, after(4), false, T0, 20);
    let channel = receive(channel, 0, after(6), false, T0 + 100, 21);
    assert_eq!(channel.candidate, after(6));
    assert_eq!(channel.deadline, T0 + WINDOW.into());
    assert_eq!(channel.anchor, state_ref::<CounterRules>(@opening()));
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
    assert_eq!(channel.result.reason, REASON_TIMEOUT);
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
