use core::testing::get_available_gas;
use starknet::testing::{set_block_timestamp, set_contract_address};
use crate::math::{self, ONE, Rating};
use crate::ratings::IRatingsDispatcherTrait;
use crate::tests::rules::{BLITZ, TestRules, test_pool};
use super::test_ratings::{alice, channel, play, setup, start};

#[test]
fn gas_of_an_update() {
    let p = test_pool();
    let a = Rating { mu: ONE / 3, phi: ONE / 3, last: 1_700_000_000 };
    let b = Rating { mu: -ONE, phi: ONE / 2, last: 1_699_000_000 };
    let before = get_available_gas();
    let (x, _, _) = math::update::<TestRules>(BLITZ, @p, a, b, 2, 1_700_086_400);
    let used = before - get_available_gas();
    println!("math::update, two established players: {used}");
    assert!(x.mu > a.mu);
    let before = get_available_gas();
    let _ = math::update::<TestRules>(BLITZ, @p, start(3), start(2), 0, 1_700_086_400);
    println!("math::update, two new players: {}", before - get_available_gas());
}

#[test]
fn gas_of_rate_game() {
    let ratings = setup();
    let (first, first_game) = play(ratings, 1, 1);
    let (second, second_game) = play(ratings, 2, 2);
    set_block_timestamp(first_game.settled_at);
    let before = get_available_gas();
    ratings.rate_game(first, first_game).unwrap();
    println!("rate_game, first game for both: {}", before - get_available_gas());
    set_block_timestamp(second_game.settled_at);
    let before = get_available_gas();
    ratings.rate_game(second, second_game).unwrap();
    println!("rate_game, second game: {}", before - get_available_gas());
    let before = get_available_gas();
    let _ = ratings.rate_game(second, second_game);
    println!("rate_game, already rated: {}", before - get_available_gas());
    set_contract_address('stranger'.try_into().unwrap());
    let before = get_available_gas();
    let _ = ratings.rate_game(second, second_game);
    println!("rate_game, unknown channel: {}", before - get_available_gas());
    set_contract_address(channel());
    let before = get_available_gas();
    ratings.player(BLITZ, alice());
    println!("player view: {}", before - get_available_gas());
}
