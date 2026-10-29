-- EsnafB2B v6.0 schema
-- All tables have RLS enabled with no policies: only the service-role key
-- (used server-side by the Python API on Vercel) can read or write.

create extension if not exists pgcrypto;

create table if not exists zones (
    id            smallint primary key,
    slug          text not null unique,
    name          text not null,
    depot_name    text not null,
    distance_m    integer not null check (distance_m > 0),
    member_target integer not null default 40 check (member_target > 0),
    quota_boxes   integer not null default 1000 check (quota_boxes > 0),
    base_boxes    integer not null default 0 check (base_boxes >= 0)
);

create table if not exists grocers (
    id        serial primary key,
    name      text not null,
    member_no integer not null unique,
    zone_id   smallint not null references zones(id),
    is_depot  boolean not null default false
);

create table if not exists products (
    id         text primary key,
    name       text not null,
    brand      text not null,
    list_price numeric(10,2) not null check (list_price > 0),
    pool_price numeric(10,2) not null check (pool_price > 0 and pool_price <= list_price),
    active     boolean not null default true
);

create table if not exists orders (
    id           uuid primary key default gen_random_uuid(),
    code         text not null unique check (code ~ '^EB2B-[A-Z2-9]{6}$'),
    grocer_id    integer not null references grocers(id),
    zone_id      smallint not null references zones(id),
    status       text not null default 'waiting'
                 check (status in ('waiting', 'delivered', 'cancelled')),
    total_list   numeric(12,2) not null check (total_list >= 0),
    total_pool   numeric(12,2) not null check (total_pool >= 0),
    commission   numeric(12,2) not null check (commission >= 0),
    created_at   timestamptz not null default now(),
    delivered_at timestamptz
);

create index if not exists orders_zone_status_idx on orders (zone_id, status);

create table if not exists order_items (
    order_id        uuid not null references orders(id) on delete cascade,
    product_id      text not null references products(id),
    qty             integer not null check (qty between 1 and 200),
    unit_list_price numeric(10,2) not null,
    unit_pool_price numeric(10,2) not null,
    primary key (order_id, product_id)
);

create table if not exists depot_applications (
    id           serial primary key,
    shop_name    text not null check (length(shop_name) between 2 and 120),
    district     text not null check (length(district) between 2 and 120),
    storage_m2   integer not null check (storage_m2 >= 12),
    truck_access text not null,
    created_at   timestamptz not null default now()
);

create table if not exists cost_model (
    sort            smallint primary key,
    label           text not null,
    traditional_pct numeric(5,2) not null,
    esnafb2b_pct    numeric(5,2) not null,
    note            text not null
);

-- Boxes committed per zone: demo baseline + every non-cancelled order.
create or replace view zone_status as
select z.id,
       z.slug,
       z.name,
       z.depot_name,
       z.distance_m,
       z.member_target,
       z.quota_boxes,
       z.base_boxes + coalesce(sum(oi.qty) filter (where o.status <> 'cancelled'), 0)::int as boxes
from zones z
left join orders o       on o.zone_id = z.id
left join order_items oi on oi.order_id = o.id
group by z.id;

-- Boxes per zone and brand, for the producer panel.
create or replace view zone_brand_boxes as
select o.zone_id, p.brand, sum(oi.qty)::int as boxes
from orders o
join order_items oi on oi.order_id = o.id
join products p     on p.id = oi.product_id
where o.status <> 'cancelled'
group by o.zone_id, p.brand;

-- Creates an order and its items in one transaction. Prices always come from
-- the products table, never from the client. Commission is 1.5% of the pool total.
create or replace function create_order(p_code text, p_grocer_id integer, p_zone_id integer, p_items jsonb)
returns orders
language plpgsql
set search_path = public
as $$
declare
    v_order orders;
    v_known integer;
begin
    if not exists (select 1 from grocers where id = p_grocer_id and zone_id = p_zone_id) then
        raise exception 'grocer_zone_mismatch' using errcode = 'P0001';
    end if;

    select count(*) into v_known
    from jsonb_to_recordset(p_items) as i(product_id text, qty integer)
    join products p on p.id = i.product_id and p.active;

    if v_known = 0 or v_known <> jsonb_array_length(p_items) then
        raise exception 'unknown_product' using errcode = 'P0001';
    end if;

    insert into orders (code, grocer_id, zone_id, total_list, total_pool, commission)
    values (p_code, p_grocer_id, p_zone_id, 0, 0, 0)
    returning * into v_order;

    insert into order_items (order_id, product_id, qty, unit_list_price, unit_pool_price)
    select v_order.id, p.id, i.qty, p.list_price, p.pool_price
    from jsonb_to_recordset(p_items) as i(product_id text, qty integer)
    join products p on p.id = i.product_id;

    update orders o
    set total_list = t.list,
        total_pool = t.pool,
        commission = round(t.pool * 0.015, 2)
    from (
        select sum(qty * unit_list_price) as list, sum(qty * unit_pool_price) as pool
        from order_items where order_id = v_order.id
    ) t
    where o.id = v_order.id
    returning o.* into v_order;

    return v_order;
end;
$$;

-- Marks a waiting order as delivered. Returns no row if the code is unknown
-- or the order is not waiting.
create or replace function deliver_order(p_code text)
returns setof orders
language sql
set search_path = public
as $$
    update orders
    set status = 'delivered', delivered_at = now()
    where code = p_code and status = 'waiting'
    returning *;
$$;

revoke execute on function create_order(text, integer, integer, jsonb) from public, anon, authenticated;
revoke execute on function deliver_order(text) from public, anon, authenticated;
grant execute on function create_order(text, integer, integer, jsonb) to service_role;
grant execute on function deliver_order(text) to service_role;

alter table zones              enable row level security;
alter table grocers            enable row level security;
alter table products           enable row level security;
alter table orders             enable row level security;
alter table order_items        enable row level security;
alter table depot_applications enable row level security;
alter table cost_model         enable row level security;

-- Views run with the caller's rights so RLS on the base tables applies.
alter view zone_status      set (security_invoker = true);
alter view zone_brand_boxes set (security_invoker = true);
