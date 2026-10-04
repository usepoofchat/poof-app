-- ETH payments. Amounts in the asset's own units (micro-dollars for stablecoins, wei for ETH) as
-- decimal text, and the ETH/USD price (8 decimals) the quote used. required_micros/received_micros
-- stay the dollar amounts (for ETH: at the quoted price).
ALTER TABLE payments ADD COLUMN required_units TEXT;
ALTER TABLE payments ADD COLUMN received_units TEXT;
ALTER TABLE payments ADD COLUMN eth_usd TEXT;
