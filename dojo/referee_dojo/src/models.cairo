use referee::Outcome;
use referee::channel::{Channel, StateRef};
use starknet::ContractAddress;

/// `ChannelUpdated.kind` values. 1 and 2 (a join and a cancel) are retired:
/// a game opens once, on every seat's signed terms.
pub const OPENED: u8 = 0;
pub const DISPUTED: u8 = 3;
pub const RECEIVED: u8 = 4;
pub const RESOLVED: u8 = 5;
pub const FORCED: u8 = 6;
pub const RESUMED: u8 = 7;
pub const TIMED_OUT: u8 = 8;
pub const RESIGNED: u8 = 9;
pub const ACKNOWLEDGED: u8 = 10;
pub const ROLLED: u8 = 11;
pub const VOIDED: u8 = 12;

#[derive(Copy, Drop, Serde, Introspect, DojoStore, PartialEq, Debug)]
pub struct StoredOutcome {
    pub finished: bool,
    pub winner: u8,
    pub reason: u8,
}

#[derive(Copy, Drop, Serde, Introspect, DojoStore, PartialEq, Debug)]
pub struct StoredRef {
    pub hash: felt252,
    pub seq: u32,
    pub support_turn: u32,
    pub due: u8,
    pub outcome: StoredOutcome,
}

/// One referee channel, as `get_channel` returns it: its terms and its state
/// together, with seats in the terms' order. `config` is the game's `Config`,
/// serialized. A timed game's `referee` key and serialized `clock_settings`
/// form its `TimeControl`, with `referee_tip`, the tip of the referee's hash
/// chain when the game takes its randomness from the referee; `referee` is
/// zero for an untimed game. Stored as `ChannelTerms`, written once when the
/// game opens, `ChannelState`, packed and written on every transition, and
/// `ChannelRng`, which only a game that takes its randomness from its referee
/// has.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct ChannelGame {
    pub id: felt252,
    pub player_0: ContractAddress,
    pub player_1: ContractAddress,
    pub key_0: felt252,
    pub key_1: felt252,
    pub tip_0: felt252,
    pub tip_1: felt252,
    pub prover: ContractAddress,
    pub config: Span<felt252>,
    pub status: u8,
    pub epoch: u32,
    pub context: felt252,
    pub response_seconds: u32,
    pub referee: felt252,
    pub clock_settings: Span<felt252>,
    pub referee_tip: felt252,
    pub anchor: StoredRef,
    pub candidate: StoredRef,
    pub anchor_block: u64,
    pub candidate_block: u64,
    pub deadline: u64,
    /// The dispute (epoch, deadline) the referee acknowledged.
    pub acked_epoch: u32,
    pub acked_deadline: u64,
    pub result: StoredOutcome,
}

/// What a channel fixes when it opens: seats, keys, randomness tips, prover,
/// config, time control and context. Written once, when the game opens.
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct ChannelTerms {
    #[key]
    pub id: felt252,
    pub player_0: ContractAddress,
    pub player_1: ContractAddress,
    pub key_0: felt252,
    pub key_1: felt252,
    pub tip_0: felt252,
    pub tip_1: felt252,
    pub prover: ContractAddress,
    pub config: Span<felt252>,
    pub context: felt252,
    pub response_seconds: u32,
    pub referee: felt252,
    pub clock_settings: Span<felt252>,
}

/// The referee's randomness for a channel whose terms take it: the tip of the
/// referee's hash chain. Kept apart from `ChannelTerms`, so a game that reveals
/// between its seats never reads or writes it: `ChannelState` says which games
/// have one.
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct ChannelRng {
    #[key]
    pub id: felt252,
    pub tip: felt252,
}

/// The channel state machine's fields in four felts: the anchor's hash, the
/// candidate's (zero while it is the anchor), and two packed words (see
/// `pack_state`). Every transition reads and writes it; clients read the
/// `ChannelUpdated` event or `get_channel` instead.
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct ChannelState {
    #[key]
    pub id: felt252,
    pub anchor: felt252,
    pub candidate: felt252,
    pub times: felt252,
    pub refs: felt252,
}

/// Proof adapter classes the namespace owner accepts.
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct ProverAllowed {
    #[key]
    pub class_hash: felt252,
    pub allowed: bool,
}

#[derive(Copy, Drop, Serde)]
#[dojo::event]
pub struct ChannelUpdated {
    #[key]
    pub game_id: felt252,
    pub kind: u8,
    pub epoch: u32,
    pub seq: u32,
    pub status: u8,
    pub deadline: u64,
    pub state_hash: felt252,
    pub winner: u8,
    pub reason: u8,
}

pub impl OutcomeIntoStored of Into<Outcome, StoredOutcome> {
    fn into(self: Outcome) -> StoredOutcome {
        StoredOutcome { finished: self.finished, winner: self.winner, reason: self.reason }
    }
}

pub impl StoredIntoOutcome of Into<StoredOutcome, Outcome> {
    fn into(self: StoredOutcome) -> Outcome {
        Outcome { finished: self.finished, winner: self.winner, reason: self.reason }
    }
}

pub impl RefIntoStored of Into<StateRef, StoredRef> {
    fn into(self: StateRef) -> StoredRef {
        StoredRef {
            hash: self.hash,
            seq: self.seq,
            support_turn: self.support_turn,
            due: self.due,
            outcome: self.outcome.into(),
        }
    }
}

pub impl StoredIntoRef of Into<StoredRef, StateRef> {
    fn into(self: StoredRef) -> StateRef {
        StateRef {
            hash: self.hash,
            seq: self.seq,
            support_turn: self.support_turn,
            due: self.due,
            outcome: self.outcome.into(),
        }
    }
}

pub fn channel_of(game: @ChannelGame) -> Channel {
    Channel {
        status: *game.status,
        epoch: *game.epoch,
        context: *game.context,
        response_seconds: *game.response_seconds,
        anchor: (*game.anchor).into(),
        candidate: (*game.candidate).into(),
        anchor_block: *game.anchor_block,
        candidate_block: *game.candidate_block,
        deadline: *game.deadline,
        acked_epoch: *game.acked_epoch,
        acked_deadline: *game.acked_deadline,
        referee_rng: *game.referee_tip != 0,
        result: (*game.result).into(),
    }
}

pub fn with_channel(mut game: ChannelGame, channel: Channel) -> ChannelGame {
    game.status = channel.status;
    game.epoch = channel.epoch;
    game.context = channel.context;
    game.response_seconds = channel.response_seconds;
    game.anchor = channel.anchor.into();
    game.candidate = channel.candidate.into();
    game.anchor_block = channel.anchor_block;
    game.candidate_block = channel.candidate_block;
    game.deadline = channel.deadline;
    game.acked_epoch = channel.acked_epoch;
    game.acked_deadline = channel.acked_deadline;
    game.result = channel.result.into();
    game
}

/// The combined view of a channel's terms and state, with the referee's tip
/// (zero for a game without one).
pub fn game_of(terms: @ChannelTerms, channel: Channel, referee_tip: felt252) -> ChannelGame {
    with_channel(
        ChannelGame {
            id: *terms.id,
            player_0: *terms.player_0,
            player_1: *terms.player_1,
            key_0: *terms.key_0,
            key_1: *terms.key_1,
            tip_0: *terms.tip_0,
            tip_1: *terms.tip_1,
            prover: *terms.prover,
            config: *terms.config,
            status: 0,
            epoch: 0,
            context: 0,
            response_seconds: 0,
            referee: *terms.referee,
            clock_settings: *terms.clock_settings,
            referee_tip,
            anchor: blank_ref(),
            candidate: blank_ref(),
            anchor_block: 0,
            candidate_block: 0,
            deadline: 0,
            acked_epoch: 0,
            acked_deadline: 0,
            result: StoredOutcome { finished: false, winner: 0, reason: 0 },
        },
        channel,
    )
}

// Packing. `times`, low 128 bits: status (8), epoch (32), deadline (40),
// anchor block (40); high: candidate block (40), acknowledged epoch (32) and
// deadline (40), and whether the referee gives the randomness (1). `refs`, low: the anchor's
// reference (89) and the result (17);
// high: the candidate's reference (89). A reference is seq (32), support turn
// (32), due seat (8) and its outcome (17): finished (1), winner (8), reason (8).
// Blocks and seconds fit 40 bits for millennia.

const TWO_8: u128 = 0x100;
const TWO_17: u128 = 0x20000;
const TWO_32: u128 = 0x100000000;
const TWO_40: u128 = 0x10000000000;
const TWO_72: u128 = 0x1000000000000000000;
const TWO_112: u128 = 0x10000000000000000000000000000;
const TWO_89: u128 = 0x20000000000000000000000;
const TWO_128: felt252 = 0x100000000000000000000000000000000;

pub fn pack_state(id: felt252, channel: @Channel) -> ChannelState {
    let c = *channel;
    let status: u128 = c.status.into();
    let epoch: u128 = c.epoch.into();
    let mut low = status + epoch * TWO_8;
    low += bits40(c.deadline) * TWO_8 * TWO_32;
    low += bits40(c.anchor_block) * TWO_8 * TWO_32 * TWO_40;
    let acked_epoch: u128 = c.acked_epoch.into();
    let referee_rng: u128 = if c.referee_rng {
        TWO_112
    } else {
        0
    };
    let high = bits40(c.candidate_block)
        + acked_epoch * TWO_40
        + bits40(c.acked_deadline) * TWO_40 * TWO_32
        + referee_rng;
    let refs_low = pack_ref(@c.anchor) + pack_outcome(@c.result) * TWO_89;
    let refs_high = pack_ref(@c.candidate);
    ChannelState {
        id,
        anchor: c.anchor.hash,
        candidate: if c.candidate.hash == c.anchor.hash {
            0
        } else {
            c.candidate.hash
        },
        times: low.into() + high.into() * TWO_128,
        refs: refs_low.into() + refs_high.into() * TWO_128,
    }
}

pub fn unpack_state(state: @ChannelState, context: felt252, response_seconds: u32) -> Channel {
    let times: u256 = (*state.times).into();
    let refs: u256 = (*state.refs).into();
    let (low, high) = (times.low, times.high);
    let anchor_hash = *state.anchor;
    let candidate_hash = if *state.candidate == 0 {
        anchor_hash
    } else {
        *state.candidate
    };
    Channel {
        status: (low % TWO_8).try_into().unwrap(),
        epoch: (low / TWO_8 % TWO_32).try_into().unwrap(),
        context,
        response_seconds,
        anchor: unpack_ref(refs.low % TWO_89, anchor_hash),
        candidate: unpack_ref(refs.high, candidate_hash),
        anchor_block: (low / (TWO_8 * TWO_32 * TWO_40) % TWO_40).try_into().unwrap(),
        candidate_block: (high % TWO_40).try_into().unwrap(),
        deadline: (low / (TWO_8 * TWO_32) % TWO_40).try_into().unwrap(),
        acked_epoch: (high / TWO_40 % TWO_32).try_into().unwrap(),
        acked_deadline: (high / (TWO_40 * TWO_32) % TWO_40).try_into().unwrap(),
        referee_rng: high / TWO_112 % 2 == 1,
        result: unpack_outcome(refs.low / TWO_89 % TWO_17),
    }
}

fn bits40(value: u64) -> u128 {
    let value: u128 = value.into();
    assert(value < TWO_40, 'Value exceeds 40 bits');
    value
}

fn pack_ref(r: @StateRef) -> u128 {
    let seq: u128 = (*r.seq).into();
    let support_turn: u128 = (*r.support_turn).into();
    let due: u128 = (*r.due).into();
    seq + support_turn * TWO_32 + due * TWO_32 * TWO_32 + pack_outcome(r.outcome) * TWO_72
}

fn unpack_ref(packed: u128, hash: felt252) -> StateRef {
    StateRef {
        hash,
        seq: (packed % TWO_32).try_into().unwrap(),
        support_turn: (packed / TWO_32 % TWO_32).try_into().unwrap(),
        due: (packed / (TWO_32 * TWO_32) % TWO_8).try_into().unwrap(),
        outcome: unpack_outcome(packed / TWO_72 % TWO_17),
    }
}

fn pack_outcome(o: @Outcome) -> u128 {
    let finished: u128 = if *o.finished {
        1
    } else {
        0
    };
    let winner: u128 = (*o.winner).into();
    let reason: u128 = (*o.reason).into();
    finished + winner * 2 + reason * 2 * TWO_8
}

fn unpack_outcome(packed: u128) -> Outcome {
    Outcome {
        finished: packed % 2 == 1,
        winner: (packed / 2 % TWO_8).try_into().unwrap(),
        reason: (packed / (2 * TWO_8) % TWO_8).try_into().unwrap(),
    }
}

fn blank_ref() -> StoredRef {
    StoredRef {
        hash: 0,
        seq: 0,
        support_turn: 0,
        due: 0,
        outcome: StoredOutcome { finished: false, winner: 0, reason: 0 },
    }
}
