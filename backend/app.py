"""EsnafB2B API. Served by Vercel's Python runtime via api/index.py."""
import os
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, field_validator

from backend import qr
from backend.repo import DuplicateCode, OrderRejected, SupabaseRepo, get_repo

CODE_ATTEMPTS = 5

app = FastAPI(title="EsnafB2B API", version="6.0", docs_url="/api/docs", openapi_url="/api/openapi.json")


@app.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(p) for p in first.get("loc", [])[1:])
    return JSONResponse({"error": f"Geçersiz istek: {field} {first.get('msg', '')}".strip()}, status_code=422)


# --- Models ---

class OrderItemIn(BaseModel):
    product_id: str = Field(pattern=r"^p\d{1,3}$")
    qty: int = Field(ge=1, le=200)


class OrderIn(BaseModel):
    grocer_id: int = Field(gt=0)
    zone_id: int = Field(gt=0, lt=1000)
    items: list[OrderItemIn] = Field(min_length=1, max_length=50)

    @field_validator("items")
    @classmethod
    def unique_products(cls, items: list[OrderItemIn]) -> list[OrderItemIn]:
        ids = [i.product_id for i in items]
        if len(ids) != len(set(ids)):
            raise ValueError("aynı ürün birden fazla kez gönderildi")
        return items


class DepotApplicationIn(BaseModel):
    shop_name: str = Field(min_length=2, max_length=120)
    district: str = Field(min_length=2, max_length=120)
    storage_m2: int = Field(ge=12, le=10000)
    truck_access: Literal["Ana cadde üzeri (tır uygun)", "Geniş sokak (kamyon / palet uygun)"]


# --- Helpers ---

def cost_totals(rows: list[dict]) -> dict:
    """Unit cost index: traditional is 100; each row's delta is applied to the EsnafB2B side."""
    traditional = 100.0
    esnaf = traditional + sum(float(r["esnafb2b_pct"]) - float(r["traditional_pct"]) for r in rows)
    return {
        "traditional": traditional,
        "esnafb2b": round(esnaf, 1),
        "saving_pct": round(traditional - esnaf, 1),
    }


def shape_order(row: dict) -> dict:
    grocer = row.get("grocers") or {}
    return {
        "code": row["code"],
        "zone_id": row["zone_id"],
        "status": row["status"],
        "grocer": grocer.get("name"),
        "member_no": grocer.get("member_no"),
        "boxes": sum(i["qty"] for i in row.get("order_items") or []),
        "total_list": float(row["total_list"]),
        "total_pool": float(row["total_pool"]),
        "commission": float(row["commission"]),
        "created_at": row.get("created_at"),
        "delivered_at": row.get("delivered_at"),
    }


def base_url(request: Request) -> str:
    return os.environ.get("PUBLIC_BASE_URL") or str(request.base_url)


def require_code(code: str) -> str:
    code = code.upper()
    if not qr.is_valid_code(code):
        raise HTTPException(400, "Geçersiz teslimat kodu")
    return code


# --- Routes ---

@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/config")
def config(repo: SupabaseRepo = Depends(get_repo)):
    cost_rows = repo.cost_model()
    return {
        "cost_model": cost_rows,
        "totals": cost_totals(cost_rows),
        "zones": repo.zones(),
        "grocers": repo.grocers(),
    }


@app.get("/api/products")
def products(repo: SupabaseRepo = Depends(get_repo)):
    return repo.products()


@app.get("/api/orders")
def list_orders(
    zone_id: int | None = Query(None, gt=0),
    status: Literal["waiting", "delivered", "cancelled"] | None = None,
    repo: SupabaseRepo = Depends(get_repo),
):
    return [shape_order(r) for r in repo.orders(zone_id, status)]


@app.get("/api/orders/{code}")
def get_order(code: str, repo: SupabaseRepo = Depends(get_repo)):
    row = repo.order_by_code(require_code(code))
    if not row:
        raise HTTPException(404, "Sipariş bulunamadı")
    return shape_order(row)


@app.post("/api/orders", status_code=201)
def create_order(body: OrderIn, request: Request, repo: SupabaseRepo = Depends(get_repo)):
    items = [i.model_dump() for i in body.items]
    for _ in range(CODE_ATTEMPTS):
        code = qr.new_code()
        try:
            repo.create_order(code, body.grocer_id, body.zone_id, items)
            break
        except DuplicateCode:
            continue
        except OrderRejected as e:
            raise HTTPException(400, f"Sipariş reddedildi: {e}")
    else:
        raise HTTPException(503, "Teslimat kodu üretilemedi, lütfen tekrar deneyin")

    order = shape_order(repo.order_by_code(code))
    order["qr_url"] = f"/api/qr/{code}.svg"
    order["pickup_url"] = qr.pickup_url(base_url(request), code)
    return order


@app.post("/api/orders/{code}/deliver")
def deliver(code: str, repo: SupabaseRepo = Depends(get_repo)):
    code = require_code(code)
    if repo.deliver_order(code) is None:
        if repo.order_by_code(code) is None:
            raise HTTPException(404, "Sipariş bulunamadı")
        raise HTTPException(409, "Bu sipariş teslim almaya uygun değil")
    return shape_order(repo.order_by_code(code))


@app.get("/api/qr/{code}.svg")
def qr_code(code: str, request: Request):
    code = require_code(code)
    svg = qr.qr_svg(qr.pickup_url(base_url(request), code))
    return Response(
        svg,
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=86400, immutable"},
    )


@app.post("/api/depot-applications", status_code=201)
def depot_application(body: DepotApplicationIn, repo: SupabaseRepo = Depends(get_repo)):
    repo.add_depot_application(body.model_dump())
    return {"ok": True}


@app.get("/api/manufacturer")
def manufacturer(brand: str | None = Query(None, max_length=40), repo: SupabaseRepo = Depends(get_repo)):
    zones = repo.zones()
    brand_rows = repo.zone_brand_boxes()
    result = []
    for z in zones:
        rows = [r for r in brand_rows if r["zone_id"] == z["id"]]
        brand_boxes = sum(r["boxes"] for r in rows if brand is None or r["brand"] == brand)
        top = sorted(rows, key=lambda r: r["boxes"], reverse=True)[:2]
        result.append({
            **z,
            "fill_pct": min(100, round(z["boxes"] / z["quota_boxes"] * 100)),
            "brand_boxes": brand_boxes,
            "top_brands": [r["brand"] for r in top],
        })
    return {"brand": brand, "zones": result}
