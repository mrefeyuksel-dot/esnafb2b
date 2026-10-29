-- EsnafB2B v6.0 demo seed data (temsili demo verisi; shop names are fictional).
-- Safe to re-run: clears demo tables first.

truncate order_items, orders, grocers, products, zones, cost_model restart identity cascade;

-- 4 Kadıköy cells, each targeting 1 Depo Bakkal + 40 member bakkals (160 total).
-- base_boxes is the demo baseline; the demo orders below add 70 / 20 / 20 / 16 boxes
-- so the zones start at 860 / 920 / 1040 / 640 of 1000.
insert into zones (id, slug, name, depot_name, distance_m, member_target, quota_boxes, base_boxes) values
    (1, 'moda-caferaga',        'Moda – Caferağa',        'Moda Merkez Bakkal',     350, 40, 1000, 790),
    (2, 'fenerbahce-goztepe',   'Fenerbahçe – Göztepe',   'Göztepe Yıldız Market',  420, 40, 1000, 900),
    (3, 'kozyatagi-bostanci',   'Kozyatağı – Bostancı',   'Bostancı Çınar Bakkal',  280, 40, 1000, 1020),
    (4, 'fikirtepe-hasanpasa',  'Fikirtepe – Hasanpaşa',  'Hasanpaşa Bereket Gıda', 500, 40, 1000, 624);

insert into grocers (name, member_no, zone_id, is_depot) values
    ('Moda Merkez Bakkal',          101, 1, true),
    ('Moda Güven Bakkal',           104, 1, false),
    ('Yoğurtçu Park Gıda',          108, 1, false),
    ('Caferağa Kardeşler Bakkal',   112, 1, false),
    ('Bahariye Köşe Market',        119, 1, false),
    ('Göztepe Yıldız Market',       201, 2, true),
    ('Fenerbahçe Deniz Bakkal',     205, 2, false),
    ('Göztepe Bereket Bakkal',      209, 2, false),
    ('Bostancı Çınar Bakkal',       301, 3, true),
    ('Kozyatağı Huzur Bakkal',      304, 3, false),
    ('Bostancı Sahil Market',       310, 3, false),
    ('Hasanpaşa Bereket Gıda',      401, 4, true),
    ('Fikirtepe Aile Bakkal',       403, 4, false),
    ('Hasanpaşa Umut Bakkal',       407, 4, false);

-- Pool prices are list price minus ~19.3%.
insert into products (id, name, brand, list_price, pool_price) values
    ('p1', 'Çikolatalı gofret kolisi (144 adet)',       'Ülker',     1200, 968),
    ('p2', 'Portakallı bisküvi kolisi (96 adet)',       'Eti',        950, 766),
    ('p3', 'Kola 1 L, 12''li koli',                      'Coca-Cola',  480, 387),
    ('p4', 'Doğal kaynak suyu 0,5 L (karma 20 koli)',   'Sırma',     1600, 1291),
    ('p5', 'Siyah çay 1 kg, 10''lu koli',                'Çaykur',    1850, 1493),
    ('p6', 'Ayçiçek yağı 5 L, 4''lü koli',               'Biryağ',    1120, 904);

-- Unit cost model. Totals: traditional 100.0 -> EsnafB2B 80.7 (19.3% saving).
-- 100 - 12 - 6.5 + 1.5 - 4.2 + 1.9 = 80.7
insert into cost_model (sort, label, traditional_pct, esnafb2b_pct, note) values
    (1, 'Distribütör ve toptancı payı',    12.0,  0.0, 'Aracısız, doğrudan fabrika alımı'),
    (2, 'Lojistik ve dağıtım',              6.5,  1.5, 'Son teslimat yok; yalnızca Depo Bakkal komisyonu'),
    (3, 'Toplu alım iskontosu',             0.0, -4.2, '1.000 kolilik peşin havuz alımı'),
    (4, 'EsnafB2B platform hizmet bedeli',  0.0,  1.9, 'Platform işletimi ve ödeme havuzu');

-- Demo orders. Totals are computed from the items below.
insert into orders (code, grocer_id, zone_id, status, total_list, total_pool, commission, created_at, delivered_at)
select v.code, g.id, g.zone_id, v.status, 0, 0, 0, v.created_at, v.delivered_at
from (values
    ('EB2B-K4892M', 104, 'waiting',   now() - interval '3 hours', null::timestamptz),
    ('EB2B-T7342P', 112, 'waiting',   now() - interval '2 hours', null),
    ('EB2B-9N4R2H', 119, 'waiting',   now() - interval '1 hour',  null),
    ('EB2B-3W4XQ8', 108, 'delivered', now() - interval '5 hours', now() - interval '4 hours'),
    ('EB2B-G7K5PR', 205, 'waiting',   now() - interval '2 hours', null),
    ('EB2B-B8M3XW', 304, 'delivered', now() - interval '6 hours', now() - interval '5 hours'),
    ('EB2B-F2H6ZD', 403, 'waiting',   now() - interval '1 hour',  null)
) as v(code, member_no, status, created_at, delivered_at)
join grocers g on g.member_no = v.member_no;

insert into order_items (order_id, product_id, qty, unit_list_price, unit_pool_price)
select o.id, p.id, v.qty, p.list_price, p.pool_price
from (values
    ('EB2B-K4892M', 'p1', 4), ('EB2B-K4892M', 'p2', 3), ('EB2B-K4892M', 'p3', 2),
    ('EB2B-K4892M', 'p4', 1), ('EB2B-K4892M', 'p5', 1), ('EB2B-K4892M', 'p6', 1),
    ('EB2B-T7342P', 'p3', 10), ('EB2B-T7342P', 'p4', 8),
    ('EB2B-9N4R2H', 'p1', 10), ('EB2B-9N4R2H', 'p2', 10), ('EB2B-9N4R2H', 'p5', 5),
    ('EB2B-3W4XQ8', 'p2', 5), ('EB2B-3W4XQ8', 'p6', 10),
    ('EB2B-G7K5PR', 'p4', 12), ('EB2B-G7K5PR', 'p2', 8),
    ('EB2B-B8M3XW', 'p1', 15), ('EB2B-B8M3XW', 'p5', 5),
    ('EB2B-F2H6ZD', 'p2', 10), ('EB2B-F2H6ZD', 'p6', 6)
) as v(code, product_id, qty)
join orders o   on o.code = v.code
join products p on p.id = v.product_id;

update orders o
set total_list = t.list,
    total_pool = t.pool,
    commission = round(t.pool * 0.015, 2)
from (
    select order_id,
           sum(qty * unit_list_price) as list,
           sum(qty * unit_pool_price) as pool
    from order_items
    group by order_id
) t
where t.order_id = o.id;
