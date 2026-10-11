use arbiter::Signature;
use starknet::{ClassHash, ContractAddress};
use crate::rules::{Pool, RatingRules};
use crate::ticket::Ticket;

/// Longest a ticket may live, from pairing to the deadline for starting its
/// game, in seconds.
pub const MAX_TICKET_LIFE: u64 = 900;
/// How far apart the clocks that date a rated game may be, in seconds: its
/// referee's (when it started), the matchmaker's (the ticket's times) and the
/// chain's (when it settled). Rating allows this much either way.
pub const MAX_CLOCK_SKEW: u64 = 60;

/// Game sources recorded by the matchmaker's ticket.
pub const QUEUE: u8 = 1;
pub const TABLE: u8 = 2;
/// `ticket_status` values: a ticket's game accepted, then rated or voided.
pub const NONE: u8 = 0;
pub const ACCEPTED: u8 = 1;
pub const RATED: u8 = 2;
pub const VOID: u8 = 3;
/// `channel_state` values beside `NONE`: an active channel takes tickets and
/// rates their games; a retiring one only rates games it already has.
pub const CHANNEL_ACTIVE: u8 = 1;
pub const CHANNEL_RETIRING: u8 = 2;
/// Matchmaker and referee key states beside `NONE`: an active key names new
/// tickets; a retired one no longer does, and its games still rate unless it
/// was revoked from a time before they were played.
pub const KEY_ACTIVE: u8 = 1;
pub const KEY_RETIRED: u8 = 2;
/// `GameVoided.reason` values.
pub const VOID_INVALID: u8 = 1;
pub const VOID_MATCHMAKER: u8 = 2;
pub const VOID_REFEREE: u8 = 3;
pub const VOID_SHORT: u8 = 4;
/// A side neither an anchor nor rated, with no band: its anchor was removed
/// before the game was rated, or both sides are anchors.
pub const VOID_ANCHOR: u8 = 5;
/// After `seal`, anything that loosens policy or trusts more waits this long
/// after it is queued, and expires `QUEUE_LIFE` after queuing.
pub const TIMELOCK_SECONDS: u64 = 172800;
pub const QUEUE_LIFE: u64 = 604800;
/// Starting bands are 1 to 7: bit b of a band mask for band b.
pub const BAND_BITS: u8 = 0b11111110;

/// A settled rated game, as the channel that hosted it reports it. Everything
/// else about the game comes from its ticket.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct GameResult {
    pub game_id: felt252,
    /// arbiter's winner: 1 seat 0, 2 seat 1, 0 a draw.
    pub winner: u8,
    /// arbiter's reason: 1..=127 the game's, `REASON_RESIGN`,
    /// `REASON_TIMEOUT` (the referee's flag) or `REASON_ABANDON` (forced play
    /// the chain judged abandoned). Any other, such as `REASON_VOID`, voids.
    pub reason: u8,
    /// When the game started, in seconds, as its referee's first stamp
    /// attests (0 if it never started): the game's time for aging. An onchain
    /// forfeit settled before any stamp reached the chain is dated by its
    /// ticket's `issued_at`.
    pub played_at: u64,
    /// When the game settled, in seconds.
    pub settled_at: u64,
    /// Steps the channel holds for the game (its latest anchor or candidate).
    pub steps: u32,
    /// Settled by an onchain resignation or abandoned forced play, whose step
    /// count may be a stale anchor's.
    pub onchain_forfeit: bool,
}

/// A player's rating and record in a pool. Unrated players read as all zeros.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
pub struct Player {
    /// μ and stored φ in Q32.32 logits.
    pub mu: i64,
    pub phi: u64,
    pub last_played: u64,
    pub games: u32,
    pub wins: u32,
    pub losses: u32,
    pub draws: u32,
    /// The rank shown (`RatingRules::shown`), with the pool's offset.
    pub shown: u16,
    /// "?": φ aged to now above the pool's provisional threshold, or no win
    /// or no loss yet.
    pub provisional: bool,
    /// Set once the rank first stops being provisional; never cleared.
    pub established: bool,
    /// At least `settled_games` games and φ aged to now at most the
    /// provisional threshold: this player's queue games against other settled
    /// players move their peak.
    pub settled: bool,
    /// Highest μ − 2φ in queue games between settled, established players.
    pub peak: i64,
    pub has_peak: bool,
    pub band: u8,
    pub params: u8,
    /// An anchor: a fixed-strength player (an AI) whose rating is pinned. Its
    /// games rate only its opponent, against the pinned μ and the pool's
    /// anchor deviation.
    pub anchor: bool,
}

#[starknet::interface]
pub trait IRatings<T> {
    /// Accept a pairing ticket once, for the active channel calling it, as
    /// game `game_id`, whose terms both players signed. Checks the matchmaker's
    /// signature, the chain, the channel, the ticket's lifetime and the
    /// rated-game policy of its pool (config, referee, clock preset, prover,
    /// response window, source, and the starting bands of unrated players),
    /// and panics otherwise. Returns the ticket's digest. It doesn't check the
    /// time: a game may open long after its ticket expired (at settlement), so
    /// rating checks that it started within the ticket's window instead.
    fn check_ticket(ref self: T, ticket: Ticket, signature: Signature, game_id: felt252) -> felt252;
    /// Rate the game of an accepted `ticket` once, from the result its channel
    /// reports. Returns `None` for anything else: a caller that isn't the
    /// ticket's channel, an unknown or finished ticket, another game. A game
    /// is voided instead if its data is invalid, it is too short, its
    /// matchmaker was revoked from before it was played, or it ended by the
    /// flag of a referee revoked from before it settled.
    fn rate_game(ref self: T, ticket: Ticket, result: GameResult) -> Option<(Player, Player)>;
    fn player(self: @T, pool: felt252, player: ContractAddress) -> Player;
    /// An anchor's pinned μ in a pool, if `player` is one there.
    fn anchor(self: @T, pool: felt252, player: ContractAddress) -> Option<i64>;
    /// (rank shown, provisional, rated) for each player.
    fn ranks(self: @T, pool: felt252, players: Span<ContractAddress>) -> Array<(u16, bool, bool)>;
    /// A ticket's status and the game it was accepted for.
    fn ticket_status(self: @T, digest: felt252) -> (u8, felt252);
    fn channel_state(self: @T, channel: ContractAddress) -> u8;
    /// A key's state and the time it was revoked from (0: not revoked).
    fn matchmaker(self: @T, key: felt252) -> (u8, u64);
    fn referee(self: @T, key: felt252) -> (u8, u64);
    fn is_clock_preset(self: @T, pool: felt252, settings: Span<felt252>) -> bool;
    /// Whether rated games in `pool` may use a config (`arbiter::config_hash`).
    fn is_config(self: @T, pool: felt252, config: felt252) -> bool;
    fn is_prover(self: @T, prover: ContractAddress) -> bool;
    /// The allowed range of dispute response windows, in seconds.
    fn response_window(self: @T) -> (u32, u32);
    /// Starting bands a new player in `pool` may choose: bit b for band b.
    fn start_bands(self: @T, pool: felt252) -> u8;
    /// Added to every rank shown in `pool`.
    fn rank_offset(self: @T, pool: felt252) -> i32;
    /// The rules' tag, version, and whether rated games take the referee's
    /// randomness.
    fn rules(self: @T) -> (felt252, u8, bool);
    /// A pool's constants, if the rules have it.
    fn pool(self: @T, pool: felt252) -> Option<Pool>;
    fn owner(self: @T) -> ContractAddress;
    fn pending_owner(self: @T) -> ContractAddress;
    fn sealed(self: @T) -> bool;
    /// When `op` was queued (0: not queued).
    fn queued(self: @T, op: felt252) -> u64;

    /// Queue or cancel a timelocked change: `op` is `admin_op::<Rules>(name,
    /// args)`.
    fn queue(ref self: T, op: felt252);
    fn cancel(ref self: T, op: felt252);
    /// End the setup phase: from now on changes that loosen policy wait for
    /// the timelock. Irreversible.
    fn seal(ref self: T);
    /// `CHANNEL_ACTIVE`, `CHANNEL_RETIRING` or `NONE`. Loosening: making a
    /// channel active, or giving a removed one rating back.
    fn set_channel(ref self: T, channel: ContractAddress, state: u8);
    /// Loosening: allow a key to name new tickets.
    fn set_matchmaker(ref self: T, key: felt252);
    fn retire_matchmaker(ref self: T, key: felt252);
    /// Retire a key and void every unrated game played at or after `at`.
    fn revoke_matchmaker(ref self: T, key: felt252, at: u64);
    fn set_referee(ref self: T, key: felt252);
    fn retire_referee(ref self: T, key: felt252);
    /// Retire a key and void every unrated game it started at or after `at`,
    /// since its first stamp dates the game, and every one its flag ended that
    /// settled at or after `at`.
    fn revoke_referee(ref self: T, key: felt252, at: u64);
    /// Allow or forbid a clock's serialized settings in a pool's rated games.
    fn set_clock_preset(ref self: T, pool: felt252, settings: Span<felt252>, allowed: bool);
    /// Allow or forbid a config (`arbiter::config_hash`) in a pool's rated
    /// games.
    fn set_config(ref self: T, pool: felt252, config: felt252, allowed: bool);
    fn set_prover(ref self: T, prover: ContractAddress, allowed: bool);
    fn set_response_window(ref self: T, min_seconds: u32, max_seconds: u32);
    /// The starting bands a new player in `pool` may choose (none until set).
    fn set_start_bands(ref self: T, pool: felt252, bands: u8);
    fn set_rank_offset(ref self: T, pool: felt252, offset: i32);
    /// Loosening: pin a player never rated in `pool` at `mu` (Q32.32) as an
    /// anchor there, or re-pin an anchor. Its games then rate only its
    /// opponent.
    fn set_anchor(ref self: T, pool: felt252, player: ContractAddress, mu: i64);
    /// The anchor's accepted games that aren't rated yet are voided.
    fn remove_anchor(ref self: T, pool: felt252, player: ContractAddress);
    /// Two steps: the new owner accepts.
    fn transfer_ownership(ref self: T, owner: ContractAddress);
    fn accept_ownership(ref self: T);
    fn upgrade(ref self: T, class_hash: ClassHash);
}

/// The hash `queue` takes for a timelocked change: the game's tag, the
/// entrypoint's name as a short string and its arguments, as Serde writes
/// them.
pub fn admin_op<impl R: RatingRules>(name: felt252, args: Span<felt252>) -> felt252 {
    let mut fields = array![R::TAG, 'ARBITER_ADMIN_V1', name];
    fields.append_span(args);
    core::poseidon::poseidon_hash_span(fields.span())
}

/// A game's ratings: players, tickets, policy, anchors and admin, under the
/// game's `RatingRules`. A game's contract embeds it and calls `initializer`
/// in its constructor.
#[starknet::component]
pub mod RatingsComponent {
    use arbiter::{REASON_ABANDON, REASON_RESIGN, REASON_TIMEOUT, Signature, verify};
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::replace_class_syscall;
    use starknet::{
        ClassHash, ContractAddress, SyscallResultTrait, get_block_timestamp, get_caller_address,
        get_contract_address, get_tx_info,
    };
    use crate::math::{self, Rating};
    use crate::rules::{BIAS_40, Pool, RatingRules, valid_pool};
    use crate::ticket::{self, Ticket};
    use super::{
        ACCEPTED, BAND_BITS, CHANNEL_ACTIVE, CHANNEL_RETIRING, GameResult, KEY_ACTIVE, KEY_RETIRED,
        MAX_CLOCK_SKEW, MAX_TICKET_LIFE, NONE, Player, QUEUE, QUEUE_LIFE, RATED, TABLE,
        TIMELOCK_SECONDS, VOID, VOID_ANCHOR, VOID_INVALID, VOID_MATCHMAKER, VOID_REFEREE,
        VOID_SHORT, admin_op,
    };

    const TWO_8: u128 = 0x100;
    const TWO_24: u128 = 0x1000000;
    const TWO_34: u128 = 0x400000000;
    const TWO_40: u128 = 0x10000000000;
    const TWO_128: felt252 = 0x100000000000000000000000000000000;
    const COUNT_MAX: u32 = 0xffffff;

    #[storage]
    pub struct Storage {
        owner: ContractAddress,
        pending_owner: ContractAddress,
        sealed: bool,
        /// Timelocked changes: when each was queued.
        queued: Map<felt252, u64>,
        channels: Map<ContractAddress, u8>,
        /// Key state and revocation time, packed.
        matchmakers: Map<felt252, u128>,
        referees: Map<felt252, u128>,
        /// A player's rating and record in a pool, packed in one felt (see
        /// `pack`).
        players: Map<(felt252, ContractAddress), felt252>,
        /// A ticket's status (`NONE` until accepted), and the game it was
        /// accepted for. Game ids are full felts (the seats' hash), so the
        /// two can't share a slot.
        tickets: Map<felt252, u8>,
        ticket_games: Map<felt252, felt252>,
        /// Per pool: Poseidon hashes of the clock settings and the configs
        /// rated games may use.
        clock_presets: Map<(felt252, felt252), bool>,
        configs: Map<(felt252, felt252), bool>,
        provers: Map<ContractAddress, bool>,
        min_response: u32,
        max_response: u32,
        start_bands: Map<felt252, u8>,
        rank_offsets: Map<felt252, i32>,
        /// Anchors' pinned μ per pool, biased as in `pack`; zero: not an
        /// anchor.
        anchors: Map<(felt252, ContractAddress), u128>,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    pub enum Event {
        RatingUpdated: RatingUpdated,
        GameVoided: GameVoided,
        TicketUsed: TicketUsed,
        ChannelSet: ChannelSet,
        KeySet: KeySet,
        PolicySet: PolicySet,
        Queued: Queued,
        Cancelled: Cancelled,
        Sealed: Sealed,
        OwnershipTransferStarted: OwnershipTransferStarted,
        OwnershipTransferred: OwnershipTransferred,
        Upgraded: Upgraded,
    }

    /// One player's side of a rated game, with its state before and after, so
    /// each event checks on its own and the chain of them replays every rating
    /// (the SDK's `verifyRatings`).
    #[derive(Drop, starknet::Event)]
    pub struct RatingUpdated {
        #[key]
        pub player: ContractAddress,
        #[key]
        pub digest: felt252,
        #[key]
        pub pool: felt252,
        pub channel: ContractAddress,
        pub game_id: felt252,
        pub opponent: ContractAddress,
        /// The player's score in half points: 2 won, 1 drew, 0 lost.
        pub score: u8,
        pub source: u8,
        pub steps: u32,
        pub played_at: u64,
        pub params: u8,
        /// The band a first game started from; 0 otherwise.
        pub band: u8,
        /// Whether the game changed this side (see `rate_game`); if not, the
        /// side was only aged, or left alone if it was never rated.
        pub applied: bool,
        pub pre_mu: i64,
        pub pre_phi: u64,
        pub pre_last: u64,
        pub mu: i64,
        pub phi: u64,
        pub last_played: u64,
        pub shown: u16,
        /// An anchor's side: its pinned rating, unchanged (`applied` false).
        pub anchor: bool,
    }

    #[derive(Drop, starknet::Event)]
    pub struct GameVoided {
        #[key]
        pub digest: felt252,
        pub channel: ContractAddress,
        pub game_id: felt252,
        pub reason: u8,
    }

    /// A pairing ticket accepted for a rated game, in full: anyone can rate the
    /// game and rebuild its rating from it.
    #[derive(Drop, starknet::Event)]
    pub struct TicketUsed {
        #[key]
        pub digest: felt252,
        #[key]
        pub channel: ContractAddress,
        #[key]
        pub pool: felt252,
        pub game_id: felt252,
        pub ticket: Ticket,
    }

    #[derive(Drop, starknet::Event)]
    pub struct ChannelSet {
        #[key]
        pub channel: ContractAddress,
        pub state: u8,
    }

    /// A matchmaker (`kind` 'matchmaker') or referee ('referee') key's state and
    /// revocation time.
    #[derive(Drop, starknet::Event)]
    pub struct KeySet {
        #[key]
        pub kind: felt252,
        #[key]
        pub key: felt252,
        pub state: u8,
        pub revoked_at: u64,
    }

    /// A change to the rated-game policy: `kind` is 'clock', 'config',
    /// 'prover', 'window', 'bands', 'offset' or 'anchor', in `pool` (0 for
    /// 'prover' and 'window'); `value` what it names (a settings hash, a
    /// config hash, an address, min·2^32 + max, a band mask, the offset +
    /// 2^31, an anchor's address), and `extra` an anchor's pinned μ + 2^39.
    #[derive(Drop, starknet::Event)]
    pub struct PolicySet {
        #[key]
        pub kind: felt252,
        #[key]
        pub pool: felt252,
        pub value: felt252,
        pub extra: felt252,
        pub allowed: bool,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Queued {
        #[key]
        pub op: felt252,
        pub ready_at: u64,
        pub expires_at: u64,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Cancelled {
        #[key]
        pub op: felt252,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Sealed {}

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipTransferStarted {
        pub owner: ContractAddress,
        pub pending: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct OwnershipTransferred {
        pub previous: ContractAddress,
        pub owner: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    pub struct Upgraded {
        pub class_hash: ClassHash,
    }

    #[embeddable_as(Ratings)]
    impl RatingsImpl<
        TContractState,
        +HasComponent<TContractState>,
        impl Rules: RatingRules,
        +Drop<TContractState>,
    > of super::IRatings<ComponentState<TContractState>> {
        fn check_ticket(
            ref self: ComponentState<TContractState>,
            ticket: Ticket,
            signature: Signature,
            game_id: felt252,
        ) -> felt252 {
            let channel = get_caller_address();
            assert(self.channels.read(channel) == CHANNEL_ACTIVE, 'Unknown channel');
            assert(ticket.channel == channel, 'Wrong channel');
            assert(ticket.chain_id == get_tx_info().unbox().chain_id, 'Wrong chain');
            assert(
                ticket.player_0.is_non_zero()
                    && ticket.player_1.is_non_zero()
                    && ticket.player_0 != ticket.player_1,
                'Invalid players',
            );
            assert(ticket.issued_at <= ticket.expires_at, 'Ticket expires before issue');
            assert(
                ticket.expires_at - ticket.issued_at <= MAX_TICKET_LIFE, 'Ticket lives too long',
            );
            assert(ticket.source == QUEUE || ticket.source == TABLE, 'Invalid source');
            let id = ticket.pool;
            let pool = Rules::pool(id).expect('Unknown pool');
            assert(valid_pool(@pool), 'Invalid pool');
            let anchor_0 = self.anchors.read((id, ticket.player_0)) != 0;
            let anchor_1 = self.anchors.read((id, ticket.player_1)) != 0;
            assert(!(anchor_0 && anchor_1), 'Two anchors');
            self.check_band(id, ticket.player_0, ticket.band_0, anchor_0);
            self.check_band(id, ticket.player_1, ticket.band_1, anchor_1);
            assert(self.configs.read((id, ticket.config)), 'Config not allowed');
            let (referee, _) = unpack_key(self.referees.read(ticket.referee));
            assert(referee == KEY_ACTIVE, 'Referee not allowed');
            assert(self.clock_presets.read((id, ticket.clock)), 'Clock not allowed');
            assert(self.provers.read(ticket.prover), 'Prover not allowed');
            assert(
                ticket.response_seconds >= self.min_response.read()
                    && ticket.response_seconds <= self.max_response.read(),
                'Response window not allowed',
            );
            let (matchmaker, _) = unpack_key(self.matchmakers.read(ticket.matchmaker));
            assert(matchmaker == KEY_ACTIVE, 'Matchmaker not allowed');
            let digest = ticket::digest::<Rules>(@ticket, get_contract_address());
            assert(self.tickets.read(digest) == NONE, 'Ticket used');
            verify(ticket.matchmaker, digest, signature);
            self.tickets.write(digest, ACCEPTED);
            self.ticket_games.write(digest, game_id);
            self.emit(TicketUsed { digest, channel, pool: id, game_id, ticket });
            digest
        }

        fn rate_game(
            ref self: ComponentState<TContractState>, ticket: Ticket, result: GameResult,
        ) -> Option<(Player, Player)> {
            let channel = get_caller_address();
            if self.channels.read(channel) == NONE || ticket.channel != channel {
                return Option::None;
            }
            let digest = ticket::digest::<Rules>(@ticket, get_contract_address());
            let (status, game_id) = (self.tickets.read(digest), self.ticket_games.read(digest));
            if status != ACCEPTED || game_id != result.game_id {
                return Option::None;
            }
            let id = ticket.pool;
            let pool = Rules::pool(id);
            let void = match pool {
                Option::Some(p) => if valid_pool(@p) {
                    self.void_reason(@ticket, @result, @p)
                } else {
                    VOID_INVALID
                },
                // An upgrade dropped the pool.
                Option::None => VOID_INVALID,
            };
            if void != 0 {
                self.tickets.write(digest, VOID);
                self.emit(GameVoided { digest, channel, game_id, reason: void });
                return Option::None;
            }
            let p = pool.unwrap();

            let t = result.played_at;
            // Seat 0's score in half points.
            let score = match result.winner {
                0 => 1,
                1 => 2,
                _ => 0,
            };
            // An anchor plays at its pinned rating, and is never stored.
            let pin_0 = self.pinned(id, @p, ticket.player_0, t);
            let pin_1 = self.pinned(id, @p, ticket.player_1, t);
            let side_0 = match pin_0 {
                Option::Some(pin) => pin,
                Option::None => self.load(id, ticket.player_0),
            };
            let side_1 = match pin_1 {
                Option::Some(pin) => pin,
                Option::None => self.load(id, ticket.player_1),
            };
            let new_0 = side_0.rating.phi == 0;
            let new_1 = side_1.rating.phi == 0;
            let start_0 = if new_0 {
                math::start::<Rules>(id, ticket.band_0)
            } else {
                Option::Some(side_0.rating)
            };
            let start_1 = if new_1 {
                math::start::<Rules>(id, ticket.band_1)
            } else {
                Option::Some(side_1.rating)
            };
            // An upgrade dropped a new player's band since the ticket.
            if start_0.is_none() || start_1.is_none() {
                self.tickets.write(digest, VOID);
                self.emit(GameVoided { digest, channel, game_id, reason: VOID_INVALID });
                return Option::None;
            }
            self.tickets.write(digest, RATED);
            let (start_0, start_1) = (start_0.unwrap(), start_1.unwrap());
            // Only games between settled players move a peak; an anchor never
            // is one, so its games move only rank. (Skipping settled players'
            // updates against unsettled ones cost accuracy and deflated the
            // scale in Surround's OGS replay.)
            let settled_0 = pin_0.is_none()
                && !new_0
                && math::settled::<Rules>(id, @p, side_0.rating, games(@side_0), t);
            let settled_1 = pin_1.is_none()
                && !new_1
                && math::settled::<Rules>(id, @p, side_1.rating, games(@side_1), t);
            // A short onchain forfeit counts only for the loser.
            let short = result.steps < p.min_steps;
            let apply_0 = pin_0.is_none() && (!short || score == 0);
            let apply_1 = pin_1.is_none() && (!short || score == 2);
            let (after_0, after_1) = math::update_states::<
                Rules,
            >(id, @p, start_0, start_1, score, t);
            let peak = ticket.source == QUEUE && settled_0 && settled_1;
            let end_0 = if pin_0.is_some() {
                side_0
            } else {
                self
                    .finish(
                        id,
                        @p,
                        ticket.player_0,
                        side_0,
                        after_0,
                        apply_0,
                        score,
                        ticket.band_0,
                        peak,
                        t,
                    )
            };
            let end_1 = if pin_1.is_some() {
                side_1
            } else {
                self
                    .finish(
                        id,
                        @p,
                        ticket.player_1,
                        side_1,
                        after_1,
                        apply_1,
                        2 - score,
                        ticket.band_1,
                        peak,
                        t,
                    )
            };
            let offset = self.rank_offsets.read(id);
            let now = get_block_timestamp();
            self
                .emit(
                    updated::<
                        Rules,
                    >(
                        @ticket,
                        @result,
                        digest,
                        channel,
                        ticket.player_0,
                        ticket.player_1,
                        score,
                        @side_0,
                        @end_0,
                        apply_0,
                        new_0,
                        ticket.band_0,
                        offset,
                        pin_0.is_some(),
                    ),
                );
            self
                .emit(
                    updated::<
                        Rules,
                    >(
                        @ticket,
                        @result,
                        digest,
                        channel,
                        ticket.player_1,
                        ticket.player_0,
                        2 - score,
                        @side_1,
                        @end_1,
                        apply_1,
                        new_1,
                        ticket.band_1,
                        offset,
                        pin_1.is_some(),
                    ),
                );
            Option::Some(
                (
                    view::<Rules>(id, @p, @end_0, now, offset, pin_0.is_some()),
                    view::<Rules>(id, @p, @end_1, now, offset, pin_1.is_some()),
                ),
            )
        }

        fn player(
            self: @ComponentState<TContractState>, pool: felt252, player: ContractAddress,
        ) -> Player {
            let p = Rules::pool(pool).expect('Unknown pool');
            self.view_of(pool, @p, player, get_block_timestamp(), self.rank_offsets.read(pool))
        }

        fn anchor(
            self: @ComponentState<TContractState>, pool: felt252, player: ContractAddress,
        ) -> Option<i64> {
            let pin = self.anchors.read((pool, player));
            if pin == 0 {
                Option::None
            } else {
                Option::Some(unbiased(pin).try_into().unwrap())
            }
        }

        fn ranks(
            self: @ComponentState<TContractState>, pool: felt252, players: Span<ContractAddress>,
        ) -> Array<(u16, bool, bool)> {
            let p = Rules::pool(pool).expect('Unknown pool');
            let mut out = array![];
            let (now, offset) = (get_block_timestamp(), self.rank_offsets.read(pool));
            for player in players {
                let v = self.view_of(pool, @p, *player, now, offset);
                out.append((v.shown, v.provisional, v.phi != 0));
            }
            out
        }

        fn ticket_status(self: @ComponentState<TContractState>, digest: felt252) -> (u8, felt252) {
            (self.tickets.read(digest), self.ticket_games.read(digest))
        }

        fn channel_state(self: @ComponentState<TContractState>, channel: ContractAddress) -> u8 {
            self.channels.read(channel)
        }

        fn matchmaker(self: @ComponentState<TContractState>, key: felt252) -> (u8, u64) {
            unpack_key(self.matchmakers.read(key))
        }

        fn referee(self: @ComponentState<TContractState>, key: felt252) -> (u8, u64) {
            unpack_key(self.referees.read(key))
        }

        fn is_clock_preset(
            self: @ComponentState<TContractState>, pool: felt252, settings: Span<felt252>,
        ) -> bool {
            self.clock_presets.read((pool, poseidon_hash_span(settings)))
        }

        fn is_config(
            self: @ComponentState<TContractState>, pool: felt252, config: felt252,
        ) -> bool {
            self.configs.read((pool, config))
        }

        fn is_prover(self: @ComponentState<TContractState>, prover: ContractAddress) -> bool {
            self.provers.read(prover)
        }

        fn response_window(self: @ComponentState<TContractState>) -> (u32, u32) {
            (self.min_response.read(), self.max_response.read())
        }

        fn start_bands(self: @ComponentState<TContractState>, pool: felt252) -> u8 {
            self.start_bands.read(pool)
        }

        fn rank_offset(self: @ComponentState<TContractState>, pool: felt252) -> i32 {
            self.rank_offsets.read(pool)
        }

        fn rules(self: @ComponentState<TContractState>) -> (felt252, u8, bool) {
            (Rules::TAG, Rules::VERSION, Rules::REFEREE_RNG)
        }

        fn pool(self: @ComponentState<TContractState>, pool: felt252) -> Option<Pool> {
            Rules::pool(pool)
        }

        fn owner(self: @ComponentState<TContractState>) -> ContractAddress {
            self.owner.read()
        }

        fn pending_owner(self: @ComponentState<TContractState>) -> ContractAddress {
            self.pending_owner.read()
        }

        fn sealed(self: @ComponentState<TContractState>) -> bool {
            self.sealed.read()
        }

        fn queued(self: @ComponentState<TContractState>, op: felt252) -> u64 {
            self.queued.read(op)
        }

        fn queue(ref self: ComponentState<TContractState>, op: felt252) {
            self.only_owner();
            let now = get_block_timestamp();
            self.queued.write(op, now);
            self
                .emit(
                    Queued { op, ready_at: now + TIMELOCK_SECONDS, expires_at: now + QUEUE_LIFE },
                );
        }

        fn cancel(ref self: ComponentState<TContractState>, op: felt252) {
            self.only_owner();
            self.queued.write(op, 0);
            self.emit(Cancelled { op });
        }

        fn seal(ref self: ComponentState<TContractState>) {
            self.only_owner();
            self.sealed.write(true);
            self.emit(Sealed {});
        }

        fn set_channel(
            ref self: ComponentState<TContractState>, channel: ContractAddress, state: u8,
        ) {
            assert(
                state == NONE || state == CHANNEL_ACTIVE || state == CHANNEL_RETIRING,
                'Invalid channel state',
            );
            let current = self.channels.read(channel);
            let loosens = state == CHANNEL_ACTIVE || (state == CHANNEL_RETIRING && current == NONE);
            self.authorize(loosens, 'set_channel', array![channel.into(), state.into()].span());
            self.channels.write(channel, state);
            self.emit(ChannelSet { channel, state });
        }

        fn set_matchmaker(ref self: ComponentState<TContractState>, key: felt252) {
            self.authorize(true, 'set_matchmaker', array![key].span());
            let (_, revoked_at) = unpack_key(self.matchmakers.read(key));
            assert(revoked_at == 0, 'Key revoked');
            self.matchmakers.write(key, pack_key(KEY_ACTIVE, 0));
            self.emit(KeySet { kind: 'matchmaker', key, state: KEY_ACTIVE, revoked_at: 0 });
        }

        fn retire_matchmaker(ref self: ComponentState<TContractState>, key: felt252) {
            self.authorize(false, 0, array![].span());
            let (_, revoked_at) = unpack_key(self.matchmakers.read(key));
            self.matchmakers.write(key, pack_key(KEY_RETIRED, revoked_at));
            self.emit(KeySet { kind: 'matchmaker', key, state: KEY_RETIRED, revoked_at });
        }

        fn revoke_matchmaker(ref self: ComponentState<TContractState>, key: felt252, at: u64) {
            self.authorize(false, 0, array![].span());
            let revoked_at = revocation(unpack_key(self.matchmakers.read(key)), at);
            self.matchmakers.write(key, pack_key(KEY_RETIRED, revoked_at));
            self.emit(KeySet { kind: 'matchmaker', key, state: KEY_RETIRED, revoked_at });
        }

        fn set_referee(ref self: ComponentState<TContractState>, key: felt252) {
            self.authorize(true, 'set_referee', array![key].span());
            let (_, revoked_at) = unpack_key(self.referees.read(key));
            assert(revoked_at == 0, 'Key revoked');
            self.referees.write(key, pack_key(KEY_ACTIVE, 0));
            self.emit(KeySet { kind: 'referee', key, state: KEY_ACTIVE, revoked_at: 0 });
        }

        fn retire_referee(ref self: ComponentState<TContractState>, key: felt252) {
            self.authorize(false, 0, array![].span());
            let (_, revoked_at) = unpack_key(self.referees.read(key));
            self.referees.write(key, pack_key(KEY_RETIRED, revoked_at));
            self.emit(KeySet { kind: 'referee', key, state: KEY_RETIRED, revoked_at });
        }

        fn revoke_referee(ref self: ComponentState<TContractState>, key: felt252, at: u64) {
            self.authorize(false, 0, array![].span());
            let revoked_at = revocation(unpack_key(self.referees.read(key)), at);
            self.referees.write(key, pack_key(KEY_RETIRED, revoked_at));
            self.emit(KeySet { kind: 'referee', key, state: KEY_RETIRED, revoked_at });
        }

        fn set_clock_preset(
            ref self: ComponentState<TContractState>,
            pool: felt252,
            settings: Span<felt252>,
            allowed: bool,
        ) {
            assert(Rules::pool(pool).is_some(), 'Unknown pool');
            let hash = poseidon_hash_span(settings);
            self.authorize(allowed, 'set_clock_preset', array![pool, hash].span());
            self.clock_presets.write((pool, hash), allowed);
            self.emit(PolicySet { kind: 'clock', pool, value: hash, extra: 0, allowed });
        }

        fn set_config(
            ref self: ComponentState<TContractState>, pool: felt252, config: felt252, allowed: bool,
        ) {
            assert(Rules::pool(pool).is_some(), 'Unknown pool');
            self.authorize(allowed, 'set_config', array![pool, config].span());
            self.configs.write((pool, config), allowed);
            self.emit(PolicySet { kind: 'config', pool, value: config, extra: 0, allowed });
        }

        fn set_prover(
            ref self: ComponentState<TContractState>, prover: ContractAddress, allowed: bool,
        ) {
            self.authorize(allowed, 'set_prover', array![prover.into()].span());
            self.provers.write(prover, allowed);
            self
                .emit(
                    PolicySet { kind: 'prover', pool: 0, value: prover.into(), extra: 0, allowed },
                );
        }

        fn set_response_window(
            ref self: ComponentState<TContractState>, min_seconds: u32, max_seconds: u32,
        ) {
            assert(min_seconds <= max_seconds, 'Invalid window');
            let tightens = min_seconds >= self.min_response.read()
                && max_seconds <= self.max_response.read();
            self
                .authorize(
                    !tightens,
                    'set_response_window',
                    array![min_seconds.into(), max_seconds.into()].span(),
                );
            self.min_response.write(min_seconds);
            self.max_response.write(max_seconds);
            let value: felt252 = min_seconds.into() * 0x100000000 + max_seconds.into();
            self.emit(PolicySet { kind: 'window', pool: 0, value, extra: 0, allowed: true });
        }

        fn set_start_bands(ref self: ComponentState<TContractState>, pool: felt252, bands: u8) {
            assert(Rules::pool(pool).is_some(), 'Unknown pool');
            assert(bands & ~BAND_BITS == 0, 'Invalid bands');
            let mut band: u8 = 1;
            while band <= 7 {
                if bands & bit(band) != 0 {
                    assert(Rules::start(pool, band).is_some(), 'Invalid bands');
                }
                band += 1;
            }
            // Removing bands tightens; adding any loosens.
            let current = self.start_bands.read(pool);
            self
                .authorize(
                    bands & ~current != 0, 'set_start_bands', array![pool, bands.into()].span(),
                );
            self.start_bands.write(pool, bands);
            self
                .emit(
                    PolicySet { kind: 'bands', pool, value: bands.into(), extra: 0, allowed: true },
                );
        }

        fn set_rank_offset(ref self: ComponentState<TContractState>, pool: felt252, offset: i32) {
            let p = Rules::pool(pool).expect('Unknown pool');
            assert(offset >= -p.max_offset && offset <= p.max_offset, 'Invalid offset');
            let value: felt252 = offset.into() + 0x80000000;
            self.authorize(true, 'set_rank_offset', array![pool, value].span());
            self.rank_offsets.write(pool, offset);
            self.emit(PolicySet { kind: 'offset', pool, value, extra: 0, allowed: true });
        }

        fn set_anchor(
            ref self: ComponentState<TContractState>,
            pool: felt252,
            player: ContractAddress,
            mu: i64,
        ) {
            let p = Rules::pool(pool).expect('Unknown pool');
            assert(player.is_non_zero(), 'Zero anchor');
            let mu: i128 = mu.into();
            assert(mu >= p.anchor_mu_min && mu <= p.anchor_mu_max, 'Invalid anchor rating');
            // A rated player's games already moved others: it can't turn
            // into a fixed point now.
            assert(self.players.read((pool, player)) == 0, 'Player is rated');
            let pin = biased(mu);
            self.authorize(true, 'set_anchor', array![pool, player.into(), pin.into()].span());
            self.anchors.write((pool, player), pin);
            self
                .emit(
                    PolicySet {
                        kind: 'anchor',
                        pool,
                        value: player.into(),
                        extra: pin.into(),
                        allowed: true,
                    },
                );
        }

        fn remove_anchor(
            ref self: ComponentState<TContractState>, pool: felt252, player: ContractAddress,
        ) {
            self.authorize(false, 0, array![].span());
            self.anchors.write((pool, player), 0);
            self
                .emit(
                    PolicySet {
                        kind: 'anchor', pool, value: player.into(), extra: 0, allowed: false,
                    },
                );
        }

        fn transfer_ownership(ref self: ComponentState<TContractState>, owner: ContractAddress) {
            assert(owner.is_non_zero(), 'Zero owner');
            self.authorize(true, 'transfer_ownership', array![owner.into()].span());
            self.pending_owner.write(owner);
            self.emit(OwnershipTransferStarted { owner: self.owner.read(), pending: owner });
        }

        fn accept_ownership(ref self: ComponentState<TContractState>) {
            let caller = get_caller_address();
            assert(
                caller == self.pending_owner.read() && caller.is_non_zero(), 'Not pending owner',
            );
            let previous = self.owner.read();
            self.owner.write(caller);
            self.pending_owner.write(Zero::zero());
            self.emit(OwnershipTransferred { previous, owner: caller });
        }

        fn upgrade(ref self: ComponentState<TContractState>, class_hash: ClassHash) {
            self.authorize(true, 'upgrade', array![class_hash.into()].span());
            replace_class_syscall(class_hash).unwrap_syscall();
            self.emit(Upgraded { class_hash });
        }
    }

    /// A player as stored.
    #[derive(Copy, Drop, PartialEq, Debug)]
    struct Stored {
        rating: Rating,
        wins: u32,
        losses: u32,
        draws: u32,
        peak: i128,
        band: u8,
        established: bool,
        has_peak: bool,
        params: u8,
    }

    #[generate_trait]
    pub impl InternalImpl<
        TContractState,
        +HasComponent<TContractState>,
        impl Rules: RatingRules,
        +Drop<TContractState>,
    > of InternalTrait<TContractState> {
        /// Set the owner; the contract's constructor calls it once.
        fn initializer(ref self: ComponentState<TContractState>, owner: ContractAddress) {
            assert(owner.is_non_zero(), 'Zero owner');
            self.owner.write(owner);
        }
    }

    #[generate_trait]
    impl PrivateImpl<
        TContractState,
        +HasComponent<TContractState>,
        impl Rules: RatingRules,
        +Drop<TContractState>,
    > of PrivateTrait<TContractState> {
        fn only_owner(self: @ComponentState<TContractState>) {
            assert(get_caller_address() == self.owner.read(), 'Only owner');
        }

        /// The owner's call, and, once sealed, a loosening change's timelock:
        /// queued at least `TIMELOCK_SECONDS` and at most `QUEUE_LIFE` ago.
        fn authorize(
            ref self: ComponentState<TContractState>,
            loosens: bool,
            name: felt252,
            args: Span<felt252>,
        ) {
            self.only_owner();
            if !loosens || !self.sealed.read() {
                return;
            }
            let op = admin_op::<Rules>(name, args);
            let at = self.queued.read(op);
            let now = get_block_timestamp();
            assert(at != 0, 'Not queued');
            assert(now >= at + TIMELOCK_SECONDS, 'Timelocked');
            assert(now <= at + QUEUE_LIFE, 'Queued change expired');
            self.queued.write(op, 0);
        }

        /// A new player's band must be one the pool's policy allows; an anchor
        /// has none (band 0).
        fn check_band(
            self: @ComponentState<TContractState>,
            pool: felt252,
            player: ContractAddress,
            band: u8,
            anchor: bool,
        ) {
            if anchor {
                assert(band == 0, 'Anchor has a band');
                return;
            }
            assert(band >= 1 && band <= 7 && Rules::start(pool, band).is_some(), 'Invalid band');
            if self.players.read((pool, player)) == 0 {
                assert(self.start_bands.read(pool) & bit(band) != 0, 'Band not allowed');
            }
        }

        fn void_reason(
            self: @ComponentState<TContractState>,
            ticket: @Ticket,
            result: @GameResult,
            pool: @Pool,
        ) -> u8 {
            let r = *result;
            // The referee's clock dates the start (0: the game never started),
            // the matchmaker's the ticket and the chain's the settlement: the
            // game must have started within the ticket's window, up to the
            // skew between them.
            // In u128, where adding the skew to any u64 time can't overflow.
            let (played, skew): (u128, u128) = (r.played_at.into(), MAX_CLOCK_SKEW.into());
            let issued: u128 = (*ticket.issued_at).into();
            let expires: u128 = (*ticket.expires_at).into();
            let settled: u128 = r.settled_at.into();
            let in_window = issued <= played + skew && played <= expires + skew;
            let valid_times = played != 0 && in_window && played <= settled
                + skew && r.settled_at <= get_block_timestamp();
            let valid_reason = (r.reason >= 1 && r.reason <= REASON_RESIGN)
                || r.reason == REASON_TIMEOUT
                || r.reason == REASON_ABANDON;
            if !valid_times || !valid_reason || r.winner > 2 {
                return VOID_INVALID;
            }
            let (_, matchmaker_revoked) = unpack_key(self.matchmakers.read(*ticket.matchmaker));
            if matchmaker_revoked != 0 && r.played_at >= matchmaker_revoked {
                return VOID_MATCHMAKER;
            }
            // The referee's first stamp dates the game, and its flag decides a
            // timeout (abandonment is the chain's judgment).
            let (_, referee_revoked) = unpack_key(self.referees.read(*ticket.referee));
            if referee_revoked != 0
                && (r.played_at >= referee_revoked
                    || (r.reason == REASON_TIMEOUT && r.settled_at >= referee_revoked)) {
                return VOID_REFEREE;
            }
            // Each side is an anchor, rated or has a band: an anchor removed
            // since its ticket leaves none of these. Two anchors (one pinned
            // after its ticket) don't rate either.
            let id = *ticket.pool;
            let anchor_0 = self.anchors.read((id, *ticket.player_0)) != 0;
            let anchor_1 = self.anchors.read((id, *ticket.player_1)) != 0;
            if (anchor_0 && anchor_1)
                || (!anchor_0
                    && *ticket.band_0 == 0
                    && self.players.read((id, *ticket.player_0)) == 0)
                || (!anchor_1
                    && *ticket.band_1 == 0
                    && self.players.read((id, *ticket.player_1)) == 0) {
                return VOID_ANCHOR;
            }
            // A short game is an abort, unless it was forfeited onchain, where
            // the anchor may be stale: then only the loser's rating changes.
            if r.steps < *pool.min_steps && (!r.onchain_forfeit || r.winner == 0) {
                return VOID_SHORT;
            }
            0
        }

        /// Store one side's end of a game and return it: the update if it
        /// applies to the side, otherwise its state only aged (or nothing, for
        /// a player never rated).
        fn finish(
            ref self: ComponentState<TContractState>,
            id: felt252,
            pool: @Pool,
            player: ContractAddress,
            before: Stored,
            after: Rating,
            apply: bool,
            score: u8,
            band: u8,
            peak: bool,
            t: u64,
        ) -> Stored {
            let new = before.rating.phi == 0;
            if !apply {
                if new {
                    return before;
                }
                let aged = Stored {
                    rating: math::age::<Rules>(id, pool, before.rating, t), ..before,
                };
                self.players.write((id, player), pack(@aged));
                return aged;
            }
            let mut end = Stored { rating: after, params: Rules::VERSION, ..before };
            if new {
                end.band = band;
            }
            match score {
                0 => end.losses = count(end.losses),
                1 => end.draws = count(end.draws),
                _ => end.wins = count(end.wins),
            }
            if !end.established && !math::provisional(pool, after.phi, end.wins, end.losses) {
                end.established = true;
            }
            if peak && end.established {
                let low = after.mu - 2 * after.phi;
                if !end.has_peak || low > end.peak {
                    end.peak = low;
                    end.has_peak = true;
                }
            }
            self.players.write((id, player), pack(@end));
            end
        }

        fn load(
            self: @ComponentState<TContractState>, id: felt252, player: ContractAddress,
        ) -> Stored {
            unpack(self.players.read((id, player)))
        }

        /// An anchor as a game at `t` sees it: its pinned μ and the pool's
        /// anchor deviation, never aged.
        fn pinned(
            self: @ComponentState<TContractState>,
            id: felt252,
            pool: @Pool,
            player: ContractAddress,
            t: u64,
        ) -> Option<Stored> {
            let pin = self.anchors.read((id, player));
            if pin == 0 {
                return Option::None;
            }
            Option::Some(
                Stored {
                    rating: Rating { mu: unbiased(pin), phi: *pool.anchor_phi, last: t },
                    ..unpack(0),
                },
            )
        }

        fn view_of(
            self: @ComponentState<TContractState>,
            id: felt252,
            pool: @Pool,
            player: ContractAddress,
            now: u64,
            offset: i32,
        ) -> Player {
            match self.pinned(id, pool, player, now) {
                Option::Some(pin) => view::<Rules>(id, pool, @pin, now, offset, true),
                Option::None => view::<Rules>(id, pool, @self.load(id, player), now, offset, false),
            }
        }
    }

    fn updated<impl R: RatingRules>(
        ticket: @Ticket,
        result: @GameResult,
        digest: felt252,
        channel: ContractAddress,
        player: ContractAddress,
        opponent: ContractAddress,
        score: u8,
        before: @Stored,
        end: @Stored,
        applied: bool,
        new: bool,
        band: u8,
        offset: i32,
        anchor: bool,
    ) -> RatingUpdated {
        let rated = end.rating.phi.is_non_zero();
        RatingUpdated {
            player,
            digest,
            pool: *ticket.pool,
            channel,
            game_id: *result.game_id,
            opponent,
            score,
            source: *ticket.source,
            steps: *result.steps,
            played_at: *result.played_at,
            params: R::VERSION,
            band: if new && applied {
                band
            } else {
                0
            },
            applied,
            pre_mu: (*before.rating.mu).try_into().unwrap(),
            pre_phi: (*before.rating.phi).try_into().unwrap(),
            pre_last: *before.rating.last,
            mu: (*end.rating.mu).try_into().unwrap(),
            phi: (*end.rating.phi).try_into().unwrap(),
            last_played: *end.rating.last,
            shown: if rated {
                R::shown(*ticket.pool, *end.rating.mu, offset)
            } else {
                0
            },
            anchor,
        }
    }

    fn games(stored: @Stored) -> u32 {
        *stored.wins + *stored.losses + *stored.draws
    }

    /// A player as the views show them at `now`: φ aged for "?" and settled.
    /// An anchor's rank is never "?", nor does it settle.
    fn view<impl R: RatingRules>(
        id: felt252, pool: @Pool, stored: @Stored, now: u64, offset: i32, anchor: bool,
    ) -> Player {
        let s = *stored;
        let rated = s.rating.phi != 0;
        let games = games(stored);
        let aged = if rated {
            math::aged_phi::<R>(id, pool, s.rating, now)
        } else {
            *pool.phi0
        };
        Player {
            mu: s.rating.mu.try_into().unwrap(),
            phi: s.rating.phi.try_into().unwrap(),
            last_played: s.rating.last,
            games,
            wins: s.wins,
            losses: s.losses,
            draws: s.draws,
            shown: if rated {
                R::shown(id, s.rating.mu, offset)
            } else {
                0
            },
            provisional: !anchor && (!rated || math::provisional(pool, aged, s.wins, s.losses)),
            established: anchor || s.established,
            settled: !anchor && rated && math::settled::<R>(id, pool, s.rating, games, now),
            peak: s.peak.try_into().unwrap(),
            has_peak: s.has_peak,
            band: s.band,
            params: s.params,
            anchor,
        }
    }

    // A counter never overflows: it holds at its maximum instead.
    fn count(n: u32) -> u32 {
        if n < COUNT_MAX {
            n + 1
        } else {
            n
        }
    }

    // Bit b of a band mask, for band b in 1..=7.
    fn bit(band: u8) -> u8 {
        match band {
            0 => 1,
            1 => 2,
            2 => 4,
            3 => 8,
            4 => 16,
            5 => 32,
            6 => 64,
            _ => 128,
        }
    }

    // A revocation time, never later than now nor than an earlier one.
    fn revocation(key: (u8, u64), at: u64) -> u64 {
        let (_, current) = key;
        assert(at > 0 && at <= get_block_timestamp(), 'Invalid revocation time');
        if current != 0 && current < at {
            current
        } else {
            at
        }
    }

    fn pack_key(state: u8, revoked_at: u64) -> u128 {
        state.into() + revoked_at.into() * TWO_8
    }

    fn unpack_key(packed: u128) -> (u8, u64) {
        ((packed % TWO_8).try_into().unwrap(), (packed / TWO_8).try_into().unwrap())
    }

    // Packing, one felt per player and pool. Low 128 bits: μ (40, biased), φ
    // (34), last played (40), band (3), established and has-peak flags (2),
    // params (8). High bits: wins, losses and draws (24 each) and peak (40,
    // biased). A zero felt is a player never rated: a rated φ is never zero.
    // `valid_pool` keeps every pool's values within these widths.

    fn biased(x: i128) -> u128 {
        (x + BIAS_40).try_into().unwrap()
    }

    fn unbiased(x: u128) -> i128 {
        let x: i128 = x.try_into().unwrap();
        x - BIAS_40
    }

    fn pack(stored: @Stored) -> felt252 {
        let s = *stored;
        let phi: u128 = s.rating.phi.try_into().unwrap();
        let last: u128 = s.rating.last.into();
        let flags: u128 = if s.established {
            1
        } else {
            0
        } + if s.has_peak {
            2
        } else {
            0
        };
        let mut low = biased(s.rating.mu);
        low += phi * TWO_40;
        low += last * TWO_40 * TWO_34;
        low += s.band.into() * TWO_40 * TWO_34 * TWO_40;
        low += flags * TWO_40 * TWO_34 * TWO_40 * 8;
        low += s.params.into() * TWO_40 * TWO_34 * TWO_40 * 32;
        let mut high: u128 = s.wins.into();
        high += s.losses.into() * TWO_24;
        high += s.draws.into() * TWO_24 * TWO_24;
        high += biased(s.peak) * TWO_24 * TWO_24 * TWO_24;
        low.into() + high.into() * TWO_128
    }

    fn unpack(packed: felt252) -> Stored {
        if packed == 0 {
            return Stored {
                rating: Rating { mu: 0, phi: 0, last: 0 },
                wins: 0,
                losses: 0,
                draws: 0,
                peak: 0,
                band: 0,
                established: false,
                has_peak: false,
                params: 0,
            };
        }
        let packed: u256 = packed.into();
        let (low, high) = (packed.low, packed.high);
        let flags = low / (TWO_40 * TWO_34 * TWO_40 * 8) % 4;
        Stored {
            rating: Rating {
                mu: unbiased(low % TWO_40),
                phi: (low / TWO_40 % TWO_34).try_into().unwrap(),
                last: (low / (TWO_40 * TWO_34) % TWO_40).try_into().unwrap(),
            },
            wins: (high % TWO_24).try_into().unwrap(),
            losses: (high / TWO_24 % TWO_24).try_into().unwrap(),
            draws: (high / (TWO_24 * TWO_24) % TWO_24).try_into().unwrap(),
            peak: unbiased(high / (TWO_24 * TWO_24 * TWO_24) % TWO_40),
            band: (low / (TWO_40 * TWO_34 * TWO_40) % 8).try_into().unwrap(),
            established: flags % 2 == 1,
            has_peak: flags / 2 == 1,
            params: (low / (TWO_40 * TWO_34 * TWO_40 * 32) % TWO_8).try_into().unwrap(),
        }
    }
}
