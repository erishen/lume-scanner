"""sig_significance 的 golden 数值测试。

背景: 显著性是新增的判断逻辑, 一旦 z/p 口径被改坏 (比如忘了取绝对值、
常数写错、normcdf 参数错位), 页面会照常显示「显著」但数字全错 —— 这种
静默错误比崩溃更危险。这里直接调用**编译后的 lume 实现**做数值断言,
而不是用 Python 复刻一遍公式 (复刻只会自证)。

期望的 p 值用 Python math.erf 独立计算标准正态 CDF, 与 lume 内建 normcdf
是两条独立路径; z 用二项检验正态近似的定义式独立算。
"""
import json
import math
import os
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
LUME = os.path.join(ROOT, "vendor", "lume", "bin", "lume")
PROBE = os.path.join(HERE, "fixtures", "sig_significance_probe.lume")


def norm_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def expected(win, n):
    """返回 (z, p) 的独立参照值: 胜率对 50% 的双侧二项检验(正态近似)。"""
    phat = win / 100.0
    se = math.sqrt(0.25 / n)
    z = (phat - 0.5) / se
    p = 2.0 * (1.0 - norm_cdf(abs(z)))
    return z, p


class SigSignificanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not os.path.exists(LUME):
            raise unittest.SkipTest(f"lume 二进制不存在: {LUME} (先 make vendor)")
        proc = subprocess.run([LUME, PROBE], cwd=ROOT, capture_output=True, text=True)
        if proc.returncode != 0:
            raise AssertionError(f"探针脚本运行失败: {proc.stderr}")
        cls.cases = {}
        for line in proc.stdout.splitlines():
            if not line.startswith("CASE\t"):
                continue
            _, name, payload = line.split("\t", 2)
            cls.cases[name] = None if payload == "null" else json.loads(payload)

    def test_golden_values(self):
        """已知输入 → 精确 z/p: 对称、极端、大样本均与独立参照一致。"""
        for name, win, n in [
            ("win50_n1000", 50.0, 1000),
            ("win60_n100", 60.0, 100),
            ("win40_n100", 40.0, 100),
            ("win30_n100", 30.0, 100),
            ("win100_n30", 100.0, 30),
            ("win0_n30", 0.0, 30),
            ("win398_n56000", 39.8, 56000),
        ]:
            with self.subTest(case=name):
                got = self.cases.get(name)
                self.assertIsNotNone(got, f"{name} 不应为 null")
                z, p = expected(win, n)
                self.assertAlmostEqual(got["z"], z, places=4, msg=f"{name} z 偏差")
                # p 可能是 4e-8 或 0(下溢), 用相对+绝对混合容差
                self.assertAlmostEqual(got["p"], p, delta=max(1e-4, abs(p) * 0.01),
                                       msg=f"{name} p 偏差")
                self.assertEqual(got["n"], n, msg=f"{name} 有效样本数")

    def test_symmetry(self):
        """胜率 60% 与 40% 的 |z| 相等、p 相等、z 符号相反。"""
        up, down = self.cases["win60_n100"], self.cases["win40_n100"]
        self.assertAlmostEqual(up["z"], -down["z"], places=6)
        self.assertAlmostEqual(up["p"], down["p"], places=7)

    def test_insufficient_sample_returns_null(self):
        """样本 <30 或 null 入参 → null (UI 显示「—」, 不假装显著)。"""
        for name in ("win50_n29", "winnull", "wnnull"):
            with self.subTest(case=name):
                self.assertIsNone(self.cases.get(name), f"{name} 应为 null")

    def test_null_base_when_win_is_50(self):
        """胜率恰为 50% → z=0, p=1 (完全不显著)。"""
        r = self.cases["win50_n1000"]
        self.assertEqual(r["z"], 0.0)
        self.assertEqual(r["p"], 1.0)


if __name__ == "__main__":
    unittest.main()
