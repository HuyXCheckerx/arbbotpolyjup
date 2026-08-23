use std::hint::black_box;
use std::time::Instant;

use jupol_domain::short_window::{eligible_cross_venue_routes, evaluate_cross_venue_routes};
use jupol_domain::strategy::{
    EntryEvaluation, ShortWindowStrategyConfig, evaluate_short_window_entry,
};
use jupol_domain::types::{BinaryOrderBook, BookLevel, SideOrderBook, Venue};

const ITERATIONS: u32 = 1_000_000;

fn main() {
    let poly = book(Venue::Polymarket, 690_000, 320_000, 680_000, 310_000);
    let mut jupiter = book(Venue::Jupiter, 770_000, 238_000, 760_000, 228_000);
    jupiter.no.asks = vec![
        BookLevel::new(238_000, 16_403_917),
        BookLevel::new(248_000, 100_000_000),
    ];
    let route = evaluate_cross_venue_routes(
        &poly,
        &jupiter,
        &eligible_cross_venue_routes(77_000_000_000, 77_010_000_000),
    )
    .expect("route evaluation")
    .remove(0);
    let config = ShortWindowStrategyConfig {
        polymarket_maximum_allocation_micro_usd: 25_000_000,
        jupiter_maximum_allocation_micro_usd: 25_000_000,
        jupiter_minimum_gross_order_micro_usd: 5_000_000,
        polymarket_minimum_gross_order_micro_usd: 1_000_000,
        polymarket_minimum_contracts_micro: 5_000_000,
        minimum_entry_edge_micro_usd_per_contract: 10_000,
        minimum_entry_edge_total_micro_usd: 100_000,
        minimum_exit_profit_micro_usd: 100_000,
    };

    let started = Instant::now();
    let mut checksum = 0_i128;
    for _ in 0..ITERATIONS {
        let result = evaluate_short_window_entry(
            black_box(Some(&route)),
            black_box(100_000_000),
            black_box(100_000_000),
            black_box(&config),
        )
        .expect("entry evaluation");
        if let EntryEvaluation::Eligible(proposal) = result {
            checksum ^= proposal.quantity_micro;
        }
    }
    let elapsed = started.elapsed();
    let nanos_per_iteration = elapsed.as_nanos() / u128::from(ITERATIONS);
    println!(
        "{ITERATIONS} exact entry evaluations in {elapsed:?} ({nanos_per_iteration} ns/eval, checksum={checksum})"
    );
}

fn book(
    venue: Venue,
    up_ask: i128,
    down_ask: i128,
    up_bid: i128,
    down_bid: i128,
) -> BinaryOrderBook {
    let contracts = 100_000_000;
    BinaryOrderBook {
        venue,
        provider: String::new(),
        market_id: String::new(),
        received_at_ms: 1,
        source_timestamp_ms: None,
        yes: SideOrderBook {
            bids: vec![BookLevel::new(up_bid, contracts)],
            asks: vec![BookLevel::new(up_ask, contracts)],
        },
        no: SideOrderBook {
            bids: vec![BookLevel::new(down_bid, contracts)],
            asks: vec![BookLevel::new(down_ask, contracts)],
        },
    }
}
