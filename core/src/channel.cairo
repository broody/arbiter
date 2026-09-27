//! The channel state machine as pure functions, ported from Surround's
//! `src/systems/channel.cairo`. Storage, caller authentication, proof checks
//! and signature checks belong to the binding (e.g. a Dojo system): it passes
//! the caller's seat, the block time and number, and whether a submission
//! carried every seat's approval.
use crate::protocol::{due, forfeit, state_hash};
use crate::rules::GameRules;
use crate::types::{Envelope, Outcome, REASON_RESIGN, REASON_TIMEOUT};

pub const WAITING: u8 = 0;
pub const ACTIVE: u8 = 1;
pub const DISPUTE: u8 = 2;
pub const FORCED: u8 = 3;
pub const SETTLED: u8 = 4;
pub const CANCELLED: u8 = 5;

pub const MIN_RESPONSE_SECONDS: u32 = 300;
pub const MAX_RESPONSE_SECONDS: u32 = 604800;

/// What the channel keeps about a state: its hash plus the fields it needs to
/// rank candidates, find the due seat and settle. The full envelope is only
/// ever supplied as calldata and checked against `hash`.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct StateRef {
    pub hash: felt252,
    pub seq: u32,
    pub support_turn: u32,
    pub due: u8,
    pub outcome: Outcome,
}

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Channel {
    pub status: u8,
    pub epoch: u32,
    pub context: felt252,
    pub response_seconds: u32,
    pub anchor: StateRef,
    pub candidate: StateRef,
    /// Block of the last anchor change. Proofs must be based at or after it.
    pub anchor_block: u64,
    pub deadline: u64,
    /// Final result once SETTLED.
    pub result: Outcome,
}

pub fn state_ref<impl R: GameRules, +Serde<R::State>, +Drop<R::State>>(
    env: @Envelope<R::State>,
) -> StateRef {
    StateRef {
        hash: state_hash::<R>(env),
        seq: *env.seq,
        support_turn: *env.support_turn,
        due: due::<R>(env),
        outcome: *env.outcome,
    }
}

pub fn create(response_seconds: u32) -> Channel {
    assert(
        response_seconds >= MIN_RESPONSE_SECONDS && response_seconds <= MAX_RESPONSE_SECONDS,
        'Invalid response window',
    );
    let empty = StateRef { hash: 0, seq: 0, support_turn: 0, due: 0, outcome: unfinished() };
    Channel {
        status: WAITING,
        epoch: 0,
        context: 0,
        response_seconds,
        anchor: empty,
        candidate: empty,
        anchor_block: 0,
        deadline: 0,
        result: unfinished(),
    }
}

/// The last seat joined. `anchor` is the opening envelope, which needs every
/// seat's randomness tip and so cannot exist before now.
pub fn join(mut channel: Channel, context: felt252, anchor: StateRef, block: u64) -> Channel {
    assert(channel.status == WAITING, 'Not waiting');
    assert(context != 0, 'Invalid context');
    assert(anchor.seq == 0 && !anchor.outcome.finished, 'Invalid opening state');
    channel.context = context;
    channel.anchor = anchor;
    channel.candidate = anchor;
    channel.anchor_block = block;
    channel.status = ACTIVE;
    channel
}

pub fn cancel(mut channel: Channel) -> Channel {
    assert(channel.status == WAITING, 'Not waiting');
    channel.status = CANCELLED;
    channel
}

/// A state proved or replayed from the anchor. With every seat's checkpoint
/// approval it commits at once. Without, it becomes the dispute candidate: it
/// must beat the current candidate, it opens a dispute if none is running, and
/// it never extends the deadline.
pub fn receive(
    mut channel: Channel, epoch: u32, end: StateRef, approved: bool, now: u64, block: u64,
) -> Channel {
    open_epoch(@channel, epoch, now);
    assert(end.seq > channel.anchor.seq, 'No channel progress');
    if approved {
        assert(end.support_turn >= channel.candidate.support_turn, 'Older than candidate');
        commit(ref channel, end, block);
        channel.deadline = 0;
        if end.outcome.finished {
            settle(ref channel, end.outcome);
        } else {
            channel.status = ACTIVE;
        }
    } else {
        assert(
            end.support_turn > channel.candidate.support_turn
                || (end.support_turn == channel.candidate.support_turn
                    && end.seq > channel.candidate.seq),
            'Not a newer candidate',
        );
        if channel.status == ACTIVE {
            channel.status = DISPUTE;
            channel.deadline = now + channel.response_seconds.into();
        }
        channel.candidate = end;
    }
    channel
}

/// A seat challenges the other to respond onchain, from the current anchor.
pub fn open_dispute(mut channel: Channel, epoch: u32, now: u64) -> Channel {
    assert(channel.status == ACTIVE, 'Not active');
    assert(channel.epoch == epoch, 'Stale channel epoch');
    channel.status = DISPUTE;
    channel.deadline = now + channel.response_seconds.into();
    channel.candidate = channel.anchor;
    channel
}

/// After the window, the best candidate becomes the anchor. An unfinished game
/// moves to forced onchain play with a fresh window, so a last-second
/// candidate can never steal the next turn by timeout.
pub fn resolve(mut channel: Channel, epoch: u32, now: u64, block: u64) -> Channel {
    assert(channel.status == DISPUTE, 'No dispute');
    assert(channel.epoch == epoch, 'Stale channel epoch');
    assert(now >= channel.deadline, 'Dispute window open');
    let candidate = channel.candidate;
    commit(ref channel, candidate, block);
    if candidate.outcome.finished {
        channel.deadline = 0;
        settle(ref channel, candidate.outcome);
    } else {
        channel.status = FORCED;
        channel.deadline = now + channel.response_seconds.into();
    }
    channel
}

/// The due seat's steps, applied onchain with `protocol::force` from the
/// anchor. `seat` is the authenticated caller.
pub fn forced(
    mut channel: Channel, epoch: u32, seat: u8, end: StateRef, now: u64, block: u64,
) -> Channel {
    forced_epoch(@channel, epoch, now);
    assert(seat == channel.anchor.due, 'Not your turn');
    assert(end.seq > channel.anchor.seq, 'No channel progress');
    commit(ref channel, end, block);
    if end.outcome.finished {
        channel.deadline = 0;
        settle(ref channel, end.outcome);
    } else {
        channel.deadline = now + channel.response_seconds.into();
    }
    channel
}

/// Every seat approved returning to offchain play from the anchor.
pub fn resume(mut channel: Channel, epoch: u32, approved: bool, now: u64, block: u64) -> Channel {
    forced_epoch(@channel, epoch, now);
    assert(approved, 'Need every approval');
    channel.status = ACTIVE;
    channel.deadline = 0;
    channel.epoch += 1;
    channel.anchor_block = block;
    channel
}

/// The waiting seat wins once the due seat misses its forced-play window.
pub fn claim_timeout(mut channel: Channel, epoch: u32, seat: u8, now: u64) -> Channel {
    assert(channel.status == FORCED, 'Not in forced play');
    assert(channel.epoch == epoch, 'Stale channel epoch');
    assert(now >= channel.deadline, 'Turn window open');
    assert(seat != channel.anchor.due, 'Only waiting seat');
    channel.epoch += 1;
    channel.deadline = 0;
    settle(ref channel, forfeit(channel.anchor.due, REASON_TIMEOUT));
    channel
}

/// A seat concedes onchain, in any live status and without a proof.
pub fn resign(mut channel: Channel, seat: u8) -> Channel {
    assert(is_live(@channel), 'Channel not live');
    channel.epoch += 1;
    channel.deadline = 0;
    settle(ref channel, forfeit(seat, REASON_RESIGN));
    channel
}

pub fn is_live(channel: @Channel) -> bool {
    *channel.status == ACTIVE || *channel.status == DISPUTE || *channel.status == FORCED
}

fn open_epoch(channel: @Channel, epoch: u32, now: u64) {
    assert(*channel.status == ACTIVE || *channel.status == DISPUTE, 'Channel not offchain');
    assert(*channel.epoch == epoch, 'Stale channel epoch');
    if *channel.status == DISPUTE {
        assert(now < *channel.deadline, 'Dispute window closed');
    }
}

fn forced_epoch(channel: @Channel, epoch: u32, now: u64) {
    assert(*channel.status == FORCED, 'Not in forced play');
    assert(*channel.epoch == epoch, 'Stale channel epoch');
    assert(now < *channel.deadline, 'Turn deadline passed');
}

fn commit(ref channel: Channel, state: StateRef, block: u64) {
    channel.anchor = state;
    channel.candidate = state;
    channel.epoch += 1;
    channel.anchor_block = block;
}

fn settle(ref channel: Channel, outcome: Outcome) {
    channel.status = SETTLED;
    channel.result = outcome;
}

fn unfinished() -> Outcome {
    Outcome { finished: false, winner: 0, reason: 0 }
}
