"""Supabase data access. Only this module talks to the database."""
import os
from functools import lru_cache

from postgrest.exceptions import APIError
from supabase import Client, create_client


class DuplicateCode(Exception):
    """The generated pickup code already exists."""


class OrderRejected(Exception):
    """The database refused the order (unknown product, grocer not in zone)."""


ORDER_FIELDS = (
    "code, zone_id, status, total_list, total_pool, commission, created_at, delivered_at,"
    " grocers(name, member_no), order_items(qty)"
)


class SupabaseRepo:
    def __init__(self, client: Client):
        self.db = client

    def cost_model(self) -> list[dict]:
        return self.db.table("cost_model").select("*").order("sort").execute().data

    def zones(self) -> list[dict]:
        return self.db.table("zone_status").select("*").order("id").execute().data

    def products(self) -> list[dict]:
        return (
            self.db.table("products")
            .select("id, name, brand, list_price, pool_price")
            .eq("active", True)
            .order("id")
            .execute()
            .data
        )

    def grocers(self) -> list[dict]:
        return self.db.table("grocers").select("*").order("member_no").execute().data

    def orders(self, zone_id: int | None, status: str | None) -> list[dict]:
        q = self.db.table("orders").select(ORDER_FIELDS)
        if zone_id is not None:
            q = q.eq("zone_id", zone_id)
        if status is not None:
            q = q.eq("status", status)
        return q.order("created_at", desc=True).limit(100).execute().data

    def order_by_code(self, code: str) -> dict | None:
        rows = self.db.table("orders").select(ORDER_FIELDS).eq("code", code).limit(1).execute().data
        return rows[0] if rows else None

    def create_order(self, code: str, grocer_id: int, zone_id: int, items: list[dict]) -> dict:
        try:
            return (
                self.db.rpc(
                    "create_order",
                    {"p_code": code, "p_grocer_id": grocer_id, "p_zone_id": zone_id, "p_items": items},
                )
                .execute()
                .data
            )
        except APIError as e:
            if e.code == "23505":
                raise DuplicateCode(code) from e
            if e.code == "P0001":
                raise OrderRejected(e.message) from e
            raise

    def deliver_order(self, code: str) -> dict | None:
        rows = self.db.rpc("deliver_order", {"p_code": code}).execute().data
        return rows[0] if rows else None

    def add_depot_application(self, row: dict) -> None:
        self.db.table("depot_applications").insert(row).execute()

    def zone_brand_boxes(self) -> list[dict]:
        return self.db.table("zone_brand_boxes").select("*").execute().data


@lru_cache(maxsize=1)
def get_repo() -> SupabaseRepo:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    return SupabaseRepo(create_client(url, key))
