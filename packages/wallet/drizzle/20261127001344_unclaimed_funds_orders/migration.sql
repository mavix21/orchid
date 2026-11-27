DELETE FROM "asset_orders"
WHERE "order"::jsonb -> 'action' ?| array['balance', 'heldFunds'];
