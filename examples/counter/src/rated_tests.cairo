//! `RatedConfig` and the config hash a pairing ticket fixes, on a config with
//! a ticket field.
use arbiter::{RatedConfig, config_hash, is_rated_config};
use crate::{Config, CounterRules};

#[derive(Copy, Drop, Serde, PartialEq, Debug)]
struct Ticketed {
    target: u8,
    ticket: felt252,
}

impl TicketedRated of RatedConfig<Ticketed> {
    fn ticket(self: @Ticketed) -> felt252 {
        *self.ticket
    }

    fn with_ticket(self: @Ticketed, ticket: felt252) -> Ticketed {
        Ticketed { ticket, ..*self }
    }
}

/// A `with_ticket` that changes more than the ticket.
#[derive(Copy, Drop, Serde, PartialEq, Debug)]
struct Sloppy {
    target: u8,
    ticket: felt252,
}

impl SloppyRated of RatedConfig<Sloppy> {
    fn ticket(self: @Sloppy) -> felt252 {
        *self.ticket
    }

    fn with_ticket(self: @Sloppy, ticket: felt252) -> Sloppy {
        Sloppy { target: 0, ticket }
    }
}

#[test]
fn an_unrated_config_carries_no_ticket() {
    let config = Config { target: 20 };
    assert_eq!(config.ticket(), 0);
    assert!(!is_rated_config(@config, 0));
    assert!(!is_rated_config(@config, 'digest'));
}

#[test]
#[should_panic(expected: ('Not a rated game',))]
fn an_unrated_config_takes_no_ticket() {
    Config { target: 20 }.with_ticket('digest');
}

#[test]
fn the_config_hash_leaves_the_ticket_out() {
    let unrated = config_hash::<CounterRules>(@Config { target: 20 });
    assert_eq!(unrated, config_hash::<CounterRules>(@Config { target: 20 }));
    assert_ne!(unrated, config_hash::<CounterRules>(@Config { target: 21 }));
}

#[test]
fn a_rated_config_carries_its_tickets_digest() {
    let config = Ticketed { target: 20, ticket: 'digest' };
    assert!(is_rated_config(@config, 'digest'));
    assert!(!is_rated_config(@config, 'other'));
    assert!(!is_rated_config(@Ticketed { target: 20, ticket: 0 }, 0));
}

#[test]
fn a_with_ticket_that_changes_more_is_refused() {
    assert!(!is_rated_config(@Sloppy { target: 20, ticket: 'digest' }, 'digest'));
}
