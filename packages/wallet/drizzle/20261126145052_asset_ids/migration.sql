UPDATE "transfers" SET "order" = regexp_replace(
  regexp_replace("order", '\{"_tag": ?"Issued", ?"code": ?"([A-Za-z0-9]{1,12})", ?"issuer": ?"(G[A-Z2-7]{55})"\}', '{"id":"\1:\2","code":"\1"}', 'g'),
  '\{"_tag": ?"Native"\}', '{"id":"native","code":"XLM"}', 'g'
)
WHERE "order" ~ '"_tag": ?"(Issued|Native)"';
--> statement-breakpoint
UPDATE "asset_orders" SET "order" = regexp_replace("order", '\{"_tag": ?"Issued", ?"code": ?"([A-Za-z0-9]{1,12})", ?"issuer": ?"(G[A-Z2-7]{55})"\}', '{"id":"\1:\2","code":"\1"}', 'g')
WHERE "order" ~ '"_tag": ?"Issued"';
--> statement-breakpoint
UPDATE "asset_orders" SET "opens" = regexp_replace("opens", '\{"_tag": ?"Issued", ?"code": ?"([A-Za-z0-9]{1,12})", ?"issuer": ?"(G[A-Z2-7]{55})"\}', '{"id":"\1:\2","code":"\1"}', 'g')
WHERE "opens" ~ '"_tag": ?"Issued"';
