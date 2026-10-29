import xml.etree.ElementTree as ET

import pytest
from fastapi.testclient import TestClient

from backend import qr
from backend.app import app, cost_totals
from backend.repo import DuplicateCode, OrderRejected, get_repo

COST_ROWS = [
    {"sort": 1, "traditional_pct": 12.0, "esnafb2b_pct": 0.0},
    {"sort": 2, "traditional_pct": 6.5, "esnafb2b_pct": 1.5},
    {"sort": 3, "traditional_pct": 0.0, "esnafb2b_pct": -4.2},
    {"sort": 4, "traditional_pct": 0.0, "esnafb2b_pct": 1.9},
]

PRODUCTS = {"p1": (1200, 968), "p2": (950, 766)}


class FakeRepo:
    """In-memory stand-in mirroring the SQL functions' behaviour."""

    def __init__(self):
        self.orders_by_code: dict[str, dict] = {}
        self.duplicates_left = 0
        self.applications = []

    def cost_model(self):
        return COST_ROWS

    def zones(self):
        return [{"id": 1, "name": "Moda – Caferağa", "boxes": 860, "quota_boxes": 1000}]

    def grocers(self):
        return [{"id": 2, "zone_id": 1, "name": "Moda Güven Bakkal", "member_no": 104}]

    def products(self):
        return [{"id": k, "list_price": v[0], "pool_price": v[1]} for k, v in PRODUCTS.items()]

    def orders(self, zone_id, status):
        return [o for o in self.orders_by_code.values() if status is None or o["status"] == status]

    def order_by_code(self, code):
        return self.orders_by_code.get(code)

    def create_order(self, code, grocer_id, zone_id, items):
        if self.duplicates_left:
            self.duplicates_left -= 1
            raise DuplicateCode(code)
        if grocer_id != 2 or zone_id != 1:
            raise OrderRejected("grocer_zone_mismatch")
        if any(i["product_id"] not in PRODUCTS for i in items):
            raise OrderRejected("unknown_product")
        total_list = sum(PRODUCTS[i["product_id"]][0] * i["qty"] for i in items)
        total_pool = sum(PRODUCTS[i["product_id"]][1] * i["qty"] for i in items)
        row = {
            "code": code, "zone_id": zone_id, "status": "waiting",
            "total_list": total_list, "total_pool": total_pool,
            "commission": round(total_pool * 0.015, 2),
            "grocers": {"name": "Moda Güven Bakkal", "member_no": 104},
            "order_items": [{"qty": i["qty"]} for i in items],
        }
        self.orders_by_code[code] = row
        return row

    def deliver_order(self, code):
        row = self.orders_by_code.get(code)
        if not row or row["status"] != "waiting":
            return None
        row["status"] = "delivered"
        return row

    def add_depot_application(self, row):
        self.applications.append(row)

    def zone_brand_boxes(self):
        return [{"zone_id": 1, "brand": "Ülker", "boxes": 30}, {"zone_id": 1, "brand": "Eti", "boxes": 10}]


@pytest.fixture
def repo():
    return FakeRepo()


@pytest.fixture
def client(repo):
    app.dependency_overrides[get_repo] = lambda: repo
    yield TestClient(app)
    app.dependency_overrides.clear()


def order_body(**overrides):
    body = {"grocer_id": 2, "zone_id": 1, "items": [{"product_id": "p1", "qty": 4}, {"product_id": "p2", "qty": 3}]}
    body.update(overrides)
    return body


# --- Cost model ---

def test_cost_model_totals_80_7():
    assert cost_totals(COST_ROWS) == {"traditional": 100.0, "esnafb2b": 80.7, "saving_pct": 19.3}


def test_config_returns_totals(client):
    data = client.get("/api/config").json()
    assert data["totals"]["saving_pct"] == 19.3
    assert data["zones"][0]["boxes"] == 860


# --- Codes and QR ---

def test_new_code_format():
    codes = {qr.new_code() for _ in range(200)}
    assert all(qr.is_valid_code(c) for c in codes)
    assert len(codes) == 200


@pytest.mark.parametrize("bad", ["EB2B-1234", "EB2B-ABCDE0", "XX-ABCDEF", "EB2B-ABCDEFG"])
def test_invalid_codes_rejected(bad):
    assert not qr.is_valid_code(bad)


def test_qr_endpoint_returns_valid_svg(client):
    res = client.get("/api/qr/EB2B-K4892M.svg")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("image/svg+xml")
    root = ET.fromstring(res.text)
    assert root.tag.endswith("svg")
    assert any(el.tag.endswith("path") for el in root.iter())


def test_qr_endpoint_rejects_bad_code(client):
    res = client.get("/api/qr/not-a-code.svg")
    assert res.status_code == 400
    assert "error" in res.json()


def test_pickup_url():
    assert qr.pickup_url("https://x.app/", "EB2B-K4892M") == "https://x.app/?teslim=EB2B-K4892M"


# --- Orders ---

def test_create_order_prices_server_side(client):
    res = client.post("/api/orders", json=order_body())
    assert res.status_code == 201
    data = res.json()
    assert data["boxes"] == 7
    assert data["total_pool"] == 968 * 4 + 766 * 3
    assert data["commission"] == round((968 * 4 + 766 * 3) * 0.015, 2)
    assert data["qr_url"] == f"/api/qr/{data['code']}.svg"
    assert data["pickup_url"].endswith(f"?teslim={data['code']}")


def test_create_order_ignores_client_prices(client):
    body = order_body(items=[{"product_id": "p1", "qty": 1, "pool_price": 1}])
    data = client.post("/api/orders", json=body).json()
    assert data["total_pool"] == 968


def test_create_order_retries_duplicate_code(client, repo):
    repo.duplicates_left = 2
    assert client.post("/api/orders", json=order_body()).status_code == 201


def test_create_order_gives_up_after_attempts(client, repo):
    repo.duplicates_left = 99
    assert client.post("/api/orders", json=order_body()).status_code == 503


def test_create_order_rejects_wrong_zone(client):
    res = client.post("/api/orders", json=order_body(zone_id=3))
    assert res.status_code == 400


@pytest.mark.parametrize("items", [
    [],
    [{"product_id": "p1", "qty": 0}],
    [{"product_id": "p1", "qty": 201}],
    [{"product_id": "p1", "qty": 1}, {"product_id": "p1", "qty": 2}],
    [{"product_id": "DROP TABLE", "qty": 1}],
])
def test_create_order_validates_items(client, items):
    res = client.post("/api/orders", json=order_body(items=items))
    assert res.status_code == 422
    assert "error" in res.json()


def test_deliver_flow(client):
    code = client.post("/api/orders", json=order_body()).json()["code"]
    first = client.post(f"/api/orders/{code}/deliver")
    assert first.status_code == 200
    assert first.json()["status"] == "delivered"
    second = client.post(f"/api/orders/{code}/deliver")
    assert second.status_code == 409


def test_deliver_unknown_code(client):
    assert client.post("/api/orders/EB2B-ZZZZZZ/deliver").status_code == 404


def test_deliver_accepts_lowercase_code(client):
    code = client.post("/api/orders", json=order_body()).json()["code"]
    assert client.post(f"/api/orders/{code.lower()}/deliver").status_code == 200


# --- Depot applications and producer panel ---

def test_depot_application_min_storage(client, repo):
    ok = {"shop_name": "Acıbadem Bakkal", "district": "Kadıköy / Acıbadem", "storage_m2": 12,
          "truck_access": "Ana cadde üzeri (tır uygun)"}
    assert client.post("/api/depot-applications", json=ok).status_code == 201
    assert client.post("/api/depot-applications", json={**ok, "storage_m2": 10}).status_code == 422
    assert len(repo.applications) == 1


def test_manufacturer_brand_filter(client):
    all_brands = client.get("/api/manufacturer").json()["zones"][0]
    assert all_brands["brand_boxes"] == 40
    assert all_brands["fill_pct"] == 86
    assert all_brands["top_brands"] == ["Ülker", "Eti"]
    eti = client.get("/api/manufacturer", params={"brand": "Eti"}).json()["zones"][0]
    assert eti["brand_boxes"] == 10
