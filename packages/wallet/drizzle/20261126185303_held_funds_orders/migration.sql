DELETE FROM "asset_orders"
WHERE "order" ~ '"_tag": ?"(ClaimBalance|ReceiveLink|ReceiveLinkExternal)"';
