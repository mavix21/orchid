DELETE FROM "asset_orders"
WHERE "order"::jsonb -> 'action' ? 'balance';
