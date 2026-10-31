"""check_privacy.py 的扫描范围测试。

背景：这类检查最容易失效的方式不是"规则写错"，而是"根本没扫到"。
只跑 `git ls-files` 时，新写的文件在提交前从来没被看过 —— 而它们恰恰最
容易带进真实网段（复制一段实测记录、贴一条 curl 命令）。等到 `git add`
之后 pre-commit 才第一次看到内容，那时发现问题已经晚了。

这些用例守的是**扫描范围**，不是规则本身。
"""
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRIPT = os.path.join(ROOT, "scripts", "check_privacy.py")

# 拼出来而不是写字面量：本文件也会被脚本扫到，直接写字面量会让自己成为
# 泄露源 —— 测试污染自己的输入。
_LEAK_IP = "192.168" + ".9.77"
LEAK_LINE = "HOST=" + _LEAK_IP + "\n"


class ScanScopeTest(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.dir = self.td.name
        r = subprocess.run(["git", "-C", self.dir, "init", "-q"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, f"git init 失败: {r.stderr}")
        self.git("config", "user.email", "t@example.com")
        self.git("config", "user.name", "t")

    def git(self, *args):
        return subprocess.run(["git", "-C", self.dir, *args],
                              capture_output=True, text=True)

    def _write(self, name, content):
        path = os.path.join(self.dir, name)
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)

    def _commit(self, name="base.txt", content="hello\n"):
        self._write(name, content)
        self.git("add", name)
        self.git("commit", "-qm", "base")

    def _scan(self, *args):
        p = subprocess.run([sys.executable, SCRIPT, "--root", self.dir, *args],
                           capture_output=True, text=True)
        return p.returncode, p.stdout + p.stderr

    def test_untracked_file_is_scanned(self):
        """未跟踪的新文件里的真实网段必须被拦下 —— 这是本检查最关键的一点。"""
        self._commit()
        self._write("new_peer.lume", LEAK_LINE)
        rc, out = self._scan()
        self.assertEqual(rc, 1, f"未跟踪文件没被扫到:\n{out}")
        self.assertIn("new_peer.lume", out)

    def test_tracked_file_is_scanned(self):
        """已跟踪文件同样要扫（回归保护）。"""
        self._commit("old.md", LEAK_LINE)
        rc, out = self._scan()
        self.assertEqual(rc, 1, out)
        self.assertIn("old.md", out)

    def test_gitignored_file_not_reported(self):
        """被 .gitignore 覆盖的文件不进仓库，报它只是噪音。"""
        self._commit(".gitignore", "*.log\n")
        self._write("run.log", LEAK_LINE)
        rc, out = self._scan()
        self.assertEqual(rc, 0, f"被忽略的文件不该报:\n{out}")

    def test_tracked_flag_restores_old_behavior(self):
        """--tracked 退回只查已跟踪。"""
        self._commit()
        self._write("new_peer.lume", LEAK_LINE)
        rc, out = self._scan("--tracked")
        self.assertEqual(rc, 0, f"--tracked 仍报了未跟踪文件:\n{out}")

    def test_staged_only_scans_index(self):
        """--staged 只看暂存区（pre-commit 钩子依赖这个语义）。"""
        self._commit()
        self._write("unstaged.lume", LEAK_LINE)
        rc, out = self._scan("--staged")
        self.assertEqual(rc, 0, f"--staged 扫到了未暂存文件:\n{out}")
        self.git("add", "unstaged.lume")
        rc, out = self._scan("--staged")
        self.assertEqual(rc, 1, f"--staged 没扫到已暂存文件:\n{out}")

    def test_example_subnet_not_reported(self):
        """示例网段 192.168.1.x 必须放行，否则文档没法写示例。"""
        self._commit("doc.md", "示例: make peer-probe PEER_HOST=192.168.1.20:18088\n")
        rc, out = self._scan()
        self.assertEqual(rc, 0, f"示例网段被误报:\n{out}")

    def test_scope_message_reflects_coverage(self):
        """通过时要说清扫了什么，否则看不出覆盖范围。"""
        self._commit()
        rc, out = self._scan()
        self.assertEqual(rc, 0, out)
        self.assertIn("未跟踪", out, f"提示没说清扫描范围: {out}")

    def test_local_without_data_degrades_visibly(self):
        """--local 但没有本机数据时，要说明"只跑了硬规则"。

        静默降级会让人以为做过本机比对 —— 实际什么都没比。
        """
        self._commit()
        rc, out = self._scan("--local")
        self.assertEqual(rc, 0, out)
        self.assertIn("仅硬规则", out, f"--local 降级没有提示: {out}")


if __name__ == "__main__":
    unittest.main()
