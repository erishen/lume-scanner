#!/usr/bin/env python3
"""生成 .data/scanner.db + .data/asset.db 样例库(lume-scanner 的 make dev 默认数据源)。

从真实 stock-analyzer 库抽一小撮标的 + 近 N 个交易日, 建两份可独立查询的 SQLite,
让 lume 服务无需依赖 8.5M 行的真实库即可冒烟/演示。
默认源: ../../../../invest-kit/apps/stock-analyzer/data/{stock_analysis,asset_snapshot}.db
可用 env SCANNER_SRC / ASSET_SRC 覆盖, 或直接 --out 指定输出目录。
"""
import argparse
import os
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE.parent / ".data"
DEFAULT_SRC = HERE.parent.parent.parent.parent / "invest-kit" / "apps" / "stock-analyzer" / "data"

STOCK_COLS = [
    "id","code","date","open","close","high","low","volume","amount",
    "amplitude","change_percent","change_amount","turnover_rate",
    "ma5","ma10","ma20","ma60","close_ma5_ratio","close_ma10_ratio",
    "close_ma20_ratio","close_ma60_ratio","ema12","ema26","macd","macd_signal",
    "macd_hist","macd_cross","rsi","rsi_oversold","rsi_overbought","boll_mid",
    "boll_std","boll_upper","boll_lower","boll_width","boll_position","kdj_rsv",
    "kdj_k","kdj_d","kdj_j","kdj_cross","atr","atr_ratio","obv","obv_ma10",
    "obv_signal","williams_r","williams_oversold","williams_overbought",
    "momentum_5d","momentum_10d","momentum_20d","roc_10","roc_20","pct_change",
    "volatility_5d","volatility_10d","volatility_20d","volatility_ratio",
    "high_low_ratio","close_open_ratio","upper_shadow","lower_shadow","body_size",
    "created_at",
]

STOCK_SCHEMA = """
CREATE TABLE IF NOT EXISTS stock_analysis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  date TEXT NOT NULL,
  open REAL, close REAL, high REAL, low REAL,
  volume REAL, amount REAL, amplitude REAL,
  change_percent REAL, change_amount REAL, turnover_rate REAL,
  ma5 REAL, ma10 REAL, ma20 REAL, ma60 REAL,
  close_ma5_ratio REAL, close_ma10_ratio REAL, close_ma20_ratio REAL,
  close_ma60_ratio REAL,
  ema12 REAL, ema26 REAL, macd REAL, macd_signal REAL, macd_hist REAL,
  macd_cross INTEGER DEFAULT 0,
  rsi REAL, rsi_oversold INTEGER DEFAULT 0, rsi_overbought INTEGER DEFAULT 0,
  boll_mid REAL, boll_std REAL, boll_upper REAL, boll_lower REAL,
  boll_width REAL, boll_position REAL,
  kdj_rsv REAL, kdj_k REAL, kdj_d REAL, kdj_j REAL, kdj_cross INTEGER DEFAULT 0,
  atr REAL, atr_ratio REAL,
  obv REAL, obv_ma10 REAL, obv_signal INTEGER DEFAULT 0,
  williams_r REAL, williams_oversold INTEGER DEFAULT 0, williams_overbought INTEGER DEFAULT 0,
  momentum_5d REAL, momentum_10d REAL, momentum_20d REAL,
  roc_10 REAL, roc_20 REAL, pct_change REAL,
  volatility_5d REAL, volatility_10d REAL, volatility_20d REAL, volatility_ratio REAL,
  high_low_ratio REAL, close_open_ratio REAL,
  upper_shadow REAL, lower_shadow REAL, body_size REAL,
  created_at TEXT,
  UNIQUE(code, date)
);
CREATE INDEX IF NOT EXISTS idx_analysis_code_date ON stock_analysis(code, date);
CREATE INDEX IF NOT EXISTS idx_analysis_date ON stock_analysis(date);
"""

ASSET_SCHEMA = """
CREATE TABLE IF NOT EXISTS asset_snapshot (
  code TEXT NOT NULL,
  name TEXT,
  close REAL,
  change_percent REAL,
  volume REAL,
  amount REAL,
  volume_ratio REAL,
  turnover_rate REAL,
  total_market_value REAL,
  float_market_value REAL,
  total_shares REAL,
  float_shares REAL,
  PRIMARY KEY(code)
);
"""

def build_stock(src_db, out_db, n_dates, n_codes):
    con_s = sqlite3.connect(src_db)
    dates = [r[0] for r in con_s.execute(
        "SELECT DISTINCT date FROM stock_analysis ORDER BY date DESC LIMIT ?", (n_dates,))]
    if not dates:
        con_s.close(); return False
    since = dates[-1]
    codes = [r[0] for r in con_s.execute(
        "SELECT DISTINCT code FROM stock_analysis WHERE date >= ? LIMIT ?", (since, n_codes))]
    rows = []
    for c in codes:
        rows.extend(con_s.execute(
            "SELECT code,date,open,close,high,low,volume,change_percent,turnover_rate,"
            "ma5,ma10,ma20,macd,macd_signal,macd_hist,macd_cross,rsi,rsi_oversold,"
            "rsi_overbought,boll_upper,boll_lower,boll_position,kdj_k,kdj_d,kdj_cross,"
            "obv,obv_signal FROM stock_analysis WHERE code=? AND date>=? ORDER BY date",
            (c, since)))
    con_s.close()

    Path(out_db).parent.mkdir(parents=True, exist_ok=True)
    if Path(out_db).exists():
        Path(out_db).unlink()
    con = sqlite3.connect(out_db)
    con.executescript(STOCK_SCHEMA)
    ph = ",".join("?" * 27)
    con.executemany(
        "INSERT OR IGNORE INTO stock_analysis(code,date,open,close,high,low,volume,"
        "change_percent,turnover_rate,ma5,ma10,ma20,macd,macd_signal,macd_hist,"
        "macd_cross,rsi,rsi_oversold,rsi_overbought,boll_upper,boll_lower,"
        "boll_position,kdj_k,kdj_d,kdj_cross,obv,obv_signal) "
        f"VALUES ({ph})", rows)
    con.commit()
    n = con.execute("SELECT COUNT(*) FROM stock_analysis").fetchone()[0]
    con.close()
    print(f"  scanner.db: {n} rows, {len(codes)} codes, {len(dates)} dates")
    return True

def build_asset(src_db, out_db, n_codes):
    cols = "code,name,close,change_percent,volume,amount,volume_ratio,turnover_rate,total_market_value,float_market_value,total_shares,float_shares"
    Path(out_db).parent.mkdir(parents=True, exist_ok=True)
    if Path(out_db).exists():
        Path(out_db).unlink()
    con = sqlite3.connect(out_db)
    con.executescript(ASSET_SCHEMA)
    ph = ",".join("?" * 12)
    for r in sqlite3.connect(src_db).execute(
            f"SELECT {cols} FROM asset_snapshot ORDER BY total_market_value DESC LIMIT ?", (n_codes,)):
        con.execute(f"INSERT OR REPLACE INTO asset_snapshot({cols}) VALUES ({ph})", r)
    con.commit()
    n = con.execute("SELECT COUNT(*) FROM asset_snapshot").fetchone()[0]
    con.close()
    print(f"  asset.db: {n} rows")
    return True

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--dates", type=int, default=5)
    ap.add_argument("--codes", type=int, default=40)
    args = ap.parse_args()

    src_stock = os.environ.get("SCANNER_SRC") or str(DEFAULT_SRC / "stock_analysis.db")
    src_asset = os.environ.get("ASSET_SRC") or str(DEFAULT_SRC / "asset_snapshot.db")
    out_dir = Path(args.out)
    out_stock = out_dir / "scanner.db"
    out_asset = out_dir / "asset.db"

    print("▶ 生成样例库…")
    ok1 = True
    ok2 = True
    if os.path.exists(src_stock):
        ok1 = build_stock(src_stock, out_stock, args.dates, args.codes)
    else:
        print(f"  源 {src_stock} 不存在, 跳过 scanner.db")
        ok1 = False
    if os.path.exists(src_asset):
        ok2 = build_asset(src_asset, out_asset, 300)
    else:
        print(f"  源 {src_asset} 不存在, 跳过 asset.db")
        ok2 = False
    if not ok1 and not ok2:
        print("✗ 两份源库都不存在, 无法生成样例"); sys.exit(1)
    print("✓ 完成")

if __name__ == "__main__":
    main()
