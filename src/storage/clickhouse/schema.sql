CREATE DATABASE IF NOT EXISTS astroidbot;

CREATE TABLE IF NOT EXISTS astroidbot.indexed_swaps
(
    chain_id String,
    dex_id String,
    pool_address String,
    tx_key String,
    tx_hash String,
    block_number UInt64,
    log_index UInt32,
    timestamp DateTime64(3, 'UTC'),
    trader_address String,
    token_in String,
    token_out String,
    amount_in UInt256,
    amount_out UInt256,
    price_0_in_1 Float64,
    price_usd Float64,
    volume_usd Float64,
    is_buy UInt8
)
ENGINE = ReplacingMergeTree()
PRIMARY KEY (chain_id, dex_id, pool_address, timestamp, tx_key)
ORDER BY (chain_id, dex_id, pool_address, timestamp, tx_key);

CREATE TABLE IF NOT EXISTS astroidbot.ohlcv_5m
(
    chain_id String,
    pool_address String,
    bucket_start DateTime64(0, 'UTC'),
    open Float64,
    high Float64,
    low Float64,
    close Float64,
    volume_usd Float64,
    txns_count UInt32
)
ENGINE = SummingMergeTree(volume_usd)
PRIMARY KEY (chain_id, pool_address, bucket_start)
ORDER BY (chain_id, pool_address, bucket_start);
