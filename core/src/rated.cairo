//! Rated or not is part of the terms every seat signs: a rated game's config
//! carries its pairing ticket's digest, 0 for an unrated game. Otherwise a
//! seat losing a rated game could open the same signed terms as an unrated
//! one, and its ticket would never be used.
//!
//! A game with rated play implements `RatedConfig` for its config. A game
//! without writes `impl Unrated of RatedConfig<Config> {}`: its configs carry
//! no ticket, and every game opens through the same check
//! (`arbiter_dojo::channel::open_game` refuses a nonzero ticket).
use core::poseidon::poseidon_hash_span;
use crate::rules::GameRules;

pub trait RatedConfig<C> {
    /// The ticket's digest; 0 for an unrated game.
    fn ticket(self: @C) -> felt252 {
        0
    }

    /// The same config with another ticket. Only a game with rated play
    /// needs it.
    fn with_ticket(self: @C, ticket: felt252) -> C {
        core::panic_with_felt252('Not a rated game')
    }
}

/// The hash a pairing ticket fixes the config by: every field but the ticket,
/// through Serde, so a game can't leave one out. A ticket can't carry the hash
/// of a config that holds its own digest.
pub fn config_hash<impl R: GameRules, +RatedConfig<R::Config>, +Serde<R::Config>, +Drop<R::Config>>(
    config: @R::Config,
) -> felt252 {
    let mut fields = array![R::TAG, 'ARBITER_CONFIG_V1'];
    if config.ticket() == 0 {
        config.serialize(ref fields);
    } else {
        config.with_ticket(0).serialize(ref fields);
    }
    poseidon_hash_span(fields.span())
}

/// Whether `config` is a rated game's config for ticket `digest`: it carries
/// the digest, and its `with_ticket` changes nothing but the ticket.
pub fn is_rated_config<C, +RatedConfig<C>, +PartialEq<C>, +Drop<C>>(
    config: @C, digest: felt252,
) -> bool {
    digest != 0 && config.ticket() == digest && @config.with_ticket(0).with_ticket(digest) == config
}
