use referee::Outcome;
use referee::channel::{Channel, StateRef};
use starknet::ContractAddress;

/// `ChannelUpdated.kind` values.
pub const CREATED: u8 = 0;
pub const JOINED: u8 = 1;
pub const CANCELLED: u8 = 2;
pub const DISPUTED: u8 = 3;
pub const RECEIVED: u8 = 4;
pub const RESOLVED: u8 = 5;
pub const FORCED: u8 = 6;
pub const RESUMED: u8 = 7;
pub const TIMED_OUT: u8 = 8;
pub const RESIGNED: u8 = 9;

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

/// One referee channel. Seat 0 is the creator, seat 1 the joiner. `config` is
/// the game's `Config`, serialized. A timed game's `referee` key and serialized
/// `clock_settings` form its `TimeControl`; `referee` is zero for an untimed
/// game.
#[derive(Copy, Drop, Serde)]
#[dojo::model]
pub struct ChannelGame {
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
    pub status: u8,
    pub epoch: u32,
    pub context: felt252,
    pub response_seconds: u32,
    pub referee: felt252,
    pub clock_settings: Span<felt252>,
    pub anchor: StoredRef,
    pub candidate: StoredRef,
    pub anchor_block: u64,
    pub deadline: u64,
    pub result: StoredOutcome,
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
        deadline: *game.deadline,
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
    game.deadline = channel.deadline;
    game.result = channel.result.into();
    game
}
