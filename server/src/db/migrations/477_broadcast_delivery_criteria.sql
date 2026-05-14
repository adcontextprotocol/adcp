-- Add SuccessCriterion IDs for broadcast TV delivery window demonstrations
-- introduced in #2047 (depends on broadcast TV protocol PR #2046, merged 2026-04-14).
-- S1 ex8: interpret get_media_buy_delivery measurement windows (live/c3/c7).
-- B3 ex2: represent partial delivery correctly to the buyer.

SELECT _append_criterion('S1', 's1_ex1', 's1_ex1_sc_broadcast_delivery_windows',
  'Calls get_media_buy_delivery on a broadcast buy and correctly interprets live/c3/c7 measurement window fields; explains that c7 DVR accumulation closes seven days post-air with additional vendor processing delay, and identifies incomplete data as by-design maturation rather than underdelivery.');

SELECT _append_criterion('B3', 'b3_ex1', 'b3_ex1_sc_broadcast_delivery_seller_communication',
  'Given a broadcast product with c3/c7 measurement windows, describes what data is available two days after the flight date, explains why c7 is incomplete, and specifies how the seller should represent partial delivery to prevent buyer misreading it as underdelivery.');
