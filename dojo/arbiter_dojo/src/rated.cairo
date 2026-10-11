//! Rated games for a game's channel, on the game's ratings contract
//! (`arbiter_ratings`). A rated game opens on its matchmaker's signed ticket,
//! whose digest its config carries (`arbiter::RatedConfig`), so the wallets'
//! signatures over the terms are their consent to the rating. Once it settles,
//! anyone may report it for rating (`rate`).
use arbiter::channel::SETTLED;
use arbiter::{Approval, GameRules, RatedConfig, Signature, Terms, config_hash, is_rated_config};
use arbiter_ratings::{
    GameResult, IRatingsDispatcher, IRatingsDispatcherTrait, Player, RatingRules, Ticket, digest,
};
use core::num::traits::Zero;
use core::poseidon::poseidon_hash_span;
use dojo::model::ModelStorage;
use dojo::world::WorldStorage;
use starknet::ContractAddress;
use crate::channel::{opened, read_state};
use crate::models::{RatedGame, Settlement, VIA_RESIGN, VIA_TIMEOUT_CLAIM};

/// Open a rated game as `channel::open_game` does, once its terms are its
/// ticket's, and have `ratings` accept the ticket for it (once). The ticket
/// fixes the seats, config, referee, clock, prover and response window; the
/// game's `Q::REFEREE_RNG` decides whether its referee gives it randomness.
pub fn open_rated_game<
    impl R: GameRules,
    impl Q: RatingRules,
    +Serde<R::Config>,
    +Drop<R::Config>,
    +RatedConfig<R::Config>,
    +PartialEq<R::Config>,
    +Serde<R::State>,
    +Drop<R::State>,
>(
    ref world: WorldStorage,
    ratings: ContractAddress,
    terms: Terms<R::Config>,
    signatures: Span<Span<felt252>>,
    referee_signature: Signature,
    ticket: Ticket,
    ticket_signature: Signature,
) {
    let mut approvals = array![];
    for signature in signatures {
        approvals.append(Approval::Wallet(*signature));
    }
    rated::<
        R, Q,
    >(ref world, ratings, terms, approvals.span(), referee_signature, 0, ticket, ticket_signature);
}

/// `open_rated_game` with `channel::open_game_delegable`'s approvals.
pub fn open_rated_game_delegable<
    impl R: GameRules,
    impl Q: RatingRules,
    +Serde<R::Config>,
    +Drop<R::Config>,
    +RatedConfig<R::Config>,
    +PartialEq<R::Config>,
    +Serde<R::State>,
    +Drop<R::State>,
>(
    ref world: WorldStorage,
    ratings: ContractAddress,
    terms: Terms<R::Config>,
    approvals: Span<Approval>,
    referee_signature: Signature,
    max_lifetime: u64,
    ticket: Ticket,
    ticket_signature: Signature,
) {
    assert(max_lifetime != 0, 'Invalid delegation lifetime');
    rated::<
        R, Q,
    >(
        ref world,
        ratings,
        terms,
        approvals,
        referee_signature,
        max_lifetime,
        ticket,
        ticket_signature,
    );
}

/// A settled rated game's result as its ratings contract takes it, from the
/// channel alone: None while the game isn't settled. The game's time is its
/// referee's first stamp; an onchain forfeit that settled before any stamp
/// reached the chain is dated by its ticket, so a losing seat can't void its
/// loss by opening the game and resigning first.
pub fn rated_result(world: @WorldStorage, game_id: felt252, ticket: @Ticket) -> Option<GameResult> {
    let channel = read_state(world, game_id);
    if channel.status != SETTLED {
        return Option::None;
    }
    let settlement: Settlement = world.read_model(game_id);
    let onchain_forfeit = settlement.via == VIA_RESIGN || settlement.via == VIA_TIMEOUT_CLAIM;
    let played_at = if channel.started == 0 && onchain_forfeit {
        *ticket.issued_at
    } else {
        channel.started
    };
    let (anchor, candidate) = (channel.anchor.seq, channel.candidate.seq);
    Option::Some(
        GameResult {
            game_id,
            winner: channel.result.winner,
            reason: channel.result.reason,
            played_at,
            settled_at: settlement.timestamp,
            steps: if anchor > candidate {
                anchor
            } else {
                candidate
            },
            onchain_forfeit,
        },
    )
}

/// Report a settled rated game to `ratings` for rating. Anyone may call it.
/// It never reverts on a game that isn't rateable (unrated, unsettled, or
/// `ratings` unset), so rating can never block a settlement, but it does on
/// another game's ticket. Returns the result as reported and both seats'
/// ratings when the contract rated the game, for a game that mirrors them.
pub fn rate<impl Q: RatingRules>(
    world: @WorldStorage, ratings: ContractAddress, game_id: felt252, ticket: Ticket,
) -> Option<(GameResult, Player, Player)> {
    let rated: RatedGame = world.read_model(game_id);
    if rated.ticket == 0 || ratings.is_zero() {
        return Option::None;
    }
    assert(digest::<Q>(@ticket, ratings) == rated.ticket, 'Not the game ticket');
    let result = rated_result(world, game_id, @ticket)?;
    let (seat_0, seat_1) = IRatingsDispatcher { contract_address: ratings }
        .rate_game(ticket, result)?;
    Option::Some((result, seat_0, seat_1))
}

// The terms must be the ticket's: the digest in the config proves the seats
// agreed to it, and these checks enforce the policy it carries.
fn rated<
    impl R: GameRules,
    impl Q: RatingRules,
    +Serde<R::Config>,
    +Drop<R::Config>,
    +RatedConfig<R::Config>,
    +PartialEq<R::Config>,
    +Serde<R::State>,
    +Drop<R::State>,
>(
    ref world: WorldStorage,
    ratings: ContractAddress,
    terms: Terms<R::Config>,
    approvals: Span<Approval>,
    referee_signature: Signature,
    max_lifetime: u64,
    ticket: Ticket,
    ticket_signature: Signature,
) {
    assert(ratings.is_non_zero(), 'Ratings not set');
    let ticket_digest = digest::<Q>(@ticket, ratings);
    assert(is_rated_config(@terms.config, ticket_digest), 'Not the ticket game');
    assert(config_hash::<R>(@terms.config) == ticket.config, 'Not the ticket config');
    assert(
        terms.players == array![ticket.player_0.into(), ticket.player_1.into()].span(),
        'Not the ticket players',
    );
    let time = terms.clock.expect('Rated game is untimed');
    assert(time.referee == ticket.referee, 'Not the ticket referee');
    assert(poseidon_hash_span(time.settings) == ticket.clock, 'Not the ticket clock');
    if Q::REFEREE_RNG {
        assert(time.rng_tip != 0, 'Rated game needs referee rolls');
    } else {
        assert(time.rng_tip == 0, 'Rated game takes no rolls');
    }
    assert(terms.prover == ticket.prover.into(), 'Not the ticket prover');
    assert(terms.response_seconds == ticket.response_seconds, 'Not the ticket window');
    let game_id = terms.game_id;
    opened::<R>(ref world, terms, approvals, referee_signature, max_lifetime);
    let accepted = IRatingsDispatcher { contract_address: ratings }
        .check_ticket(ticket, ticket_signature, game_id);
    world.write_model(@RatedGame { game_id, ticket: accepted });
}
