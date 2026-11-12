"""refresh.py and fetch.py without the network: CMS's pages and files are faked."""
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

import fetch
import history
import refresh

INDEX = refresh.QUARTERLY_PAGE


def table_zip(member, header="HCPCS Code,Short Descriptor,SI", count=60, si="C"):
    rows = [header] + ["%05d,x,%s" % (n, si) for n in range(100, 100 + count)]
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr(member, "\n".join(rows))
    return data.getvalue()


def page(*links):
    return "".join('<a href="%s">%s</a>' % link for link in links)


class Urls(unittest.TestCase):
    def test_license_wrapper_is_unwrapped_and_other_hosts_refused(self):
        self.assertEqual(refresh.file_url("https://www.cms.gov/license/ama?file=/files/zip/x.zip"), "https://www.cms.gov/files/zip/x.zip")
        self.assertEqual(refresh.file_url("https://edit.cms.gov/files/zip/x.zip"), "https://www.cms.gov/files/zip/x.zip")
        self.assertIsNone(refresh.file_url("https://www.cms.gov/license/ama?file=//evil.example/x.zip"))
        self.assertIsNone(refresh.file_url("https://evil.example/files/zip/x.zip"))
        self.assertIsNone(refresh.file_url("http://www.cms.gov/files/zip/x.zip"))
        self.assertIsNone(refresh.file_url("https://www.cms.gov/files/document/x.pdf"))

    def test_quarter_of(self):
        self.assertEqual(refresh.quarter_of("January 2027 - updated 01/20/2027"), "2027-01")
        self.assertEqual(refresh.quarter_of("2025 October"), "2025-10")
        self.assertIsNone(refresh.quarter_of("October"))
        self.assertIsNone(refresh.quarter_of("Addendum B"))

    def test_download_refuses_hosts_off_the_allowlist(self):
        for url in ("https://evil.example/x.zip", "http://www.cms.gov/x.zip", "file:///etc/passwd"):
            with self.assertRaises(ValueError):
                fetch.download(url)

    def test_raw_path_cannot_leave_its_folder(self):
        for url in ("https://www.cms.gov/files/zip/..%2F..%2F..%2Fpipeline%2Fx.zip",
                    "https://www.cms.gov/files/zip/x.zip?v=../../y", "https://www.cms.gov/files/zip/%2Fetc%2Fpasswd"):
            path = fetch.raw_path({"id": "../b-2099-01", "url": url}).resolve()
            self.assertEqual(path.parent.parent, fetch.RAW.resolve(), url)
        self.assertEqual(fetch.raw_path({"id": "b-1", "url": "https://www.cms.gov/files/zip/Good-Name_1.zip"}).name, "Good-Name_1.zip")


class Discovery(unittest.TestCase):
    def setUp(self):
        self.manifest = {"sources": [
            {"id": "b-2026-07", "kind": "addendum_b", "effective": "2026-07-01", "url": "https://www.cms.gov/files/zip/july-b.zip", "landing": INDEX, "sha256": "x"},
            {"id": "addenda-2027", "kind": "rule_addenda", "cy": 2027, "rule": "CMS-1850-FC", "url": "https://www.cms.gov/files/zip/2027-addenda.zip",
             "landing": "https://www.cms.gov/regs/cms-1850-fc", "sha256": "x"},
        ]}
        self.files = {
            "https://www.cms.gov/files/zip/odd-name-2026-10.zip": table_zip("2026 October Web Addendum B.csv"),
            "https://www.cms.gov/files/zip/october-a.zip": table_zip("2026 October Web Addendum A.csv"),
            "https://www.cms.gov/files/zip/july-b-updated.zip": table_zip("2026 July Web Addendum B v2.csv"),
            "https://www.cms.gov/files/zip/not-a-zip.zip": b"<html>Access denied</html>",
        }
        self.pages = {
            INDEX: page(("/q/october-2026", "October 2026"), ("/q/october-2026-0", "October 2026"), ("/q/july-2026-0", "July 2026 - updated")),
            "https://www.cms.gov/q/october-2026": page(("/license/ama?file=/files/zip/october-a.zip", "A")),
            "https://www.cms.gov/q/october-2026-0": page(("/apps/ama/license.asp?file=/files/zip/odd-name-2026-10.zip", "B"),
                                                        ("/license/ama?file=/files/zip/not-a-zip.zip", "B again")),
            "https://www.cms.gov/q/july-2026-0": page(("/license/ama?file=/files/zip/july-b.zip", "B"), ("/license/ama?file=/files/zip/july-b-updated.zip", "B updated")),
        }

    def test_new_quarter_and_correction_are_found_by_content_not_name(self):
        found = refresh.discover_quarters(self.manifest, self.pages.__getitem__, self.files.get)
        self.assertEqual([(source["id"], source["url"].rsplit("/", 1)[-1]) for source, _ in found],
                         [("b-2026-07", "july-b-updated.zip"), ("b-2026-10", "odd-name-2026-10.zip")])
        self.assertEqual(sorted(url.rsplit("/", 1)[-1] for url in self.manifest["ignored"]), ["not-a-zip.zip", "october-a.zip"])
        downloads = []
        refresh.discover_quarters(self.manifest, self.pages.__getitem__, lambda url: downloads.append(url) or self.files.get(url))
        self.assertFalse([url for url in downloads if url in self.manifest["ignored"]], "an ignored address was downloaded again")

    def test_two_candidate_rule_files_are_reported_not_guessed(self):
        self.pages[refresh.RULES_PAGE] = page(("/regs/cms-1900-fc", "CY 2028 final rule"))
        self.pages["https://www.cms.gov/regs/cms-1900-fc"] = page(
            ("/license/ama?file=/files/zip/2028-addenda.zip", "2028 NFRM OPPS Addenda"),
            ("/license/ama?file=/files/zip/2028-addenda-updated.zip", "2028 NFRM OPPS Addenda - Updated"),
            ("/license/ama?file=/files/zip/2028-removed.zip", "2028 FR Procedures for Removal from IPO List"))
        self.files["https://www.cms.gov/files/zip/2028-removed.zip"] = table_zip("2028 Procedures for Removal.csv", si="J1")
        found, notes = refresh.discover_rules(self.manifest, self.pages.__getitem__, self.files.get)
        self.assertEqual([(source["id"], source["rule"]) for source, _ in found], [("removed-2028", "CMS-1900-FC")])
        self.assertEqual(len(notes), 1)
        self.assertIn("addenda-2028", notes[0])


class Adopt(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.real_raw, fetch.RAW = fetch.RAW, Path(self.directory.name)
        self.addCleanup(setattr, fetch, "RAW", self.real_raw)

    def source(self, name):
        return {"id": "b-2026-10", "kind": "addendum_b", "effective": "2026-10-01", "url": "https://www.cms.gov/files/zip/%s.zip" % name,
                "landing": INDEX, "sha256": None}

    def test_corrections_chain_and_the_last_is_in_force(self):
        manifest = {"sources": []}
        for name in ("first", "second", "third"):
            refresh.adopt(manifest, self.source(name), name.encode())
        self.assertEqual([(s["id"], s.get("corrects")) for s in manifest["sources"]],
                         [("b-2026-10", None), ("b-2026-10-corr", "b-2026-10"), ("b-2026-10-corr2", "b-2026-10-corr")])
        self.assertEqual(fetch.raw_path(manifest["sources"][2]).read_bytes(), b"third")
        for order in (manifest["sources"], manifest["sources"][::-1]):
            self.assertEqual(history.build_periods(order)[0]["source"], "b-2026-10-corr2")

    def test_two_uncorrected_files_for_a_quarter_are_an_error(self):
        sources = [dict(self.source("a"), id="b-2026-10"), dict(self.source("b"), id="b-2026-10-x")]
        with self.assertRaises(ValueError):
            history.build_periods(sources)

    def test_reposted_rule_file_replaces_the_copy_on_file(self):
        old = {"id": "addenda-2027", "kind": "rule_addenda", "cy": 2027, "rule": "CMS-1850-FC", "url": "https://www.cms.gov/files/zip/old.zip", "landing": "x", "sha256": "old"}
        fetch.raw_path(old).parent.mkdir(parents=True)
        fetch.raw_path(old).write_bytes(b"old bytes")
        manifest = {"sources": [old]}
        refresh.adopt(manifest, dict(old, url="https://www.cms.gov/files/zip/new.zip", sha256=None), b"new bytes")
        self.assertEqual(len(manifest["sources"]), 1)
        self.assertEqual(manifest["sources"][0]["url"], "https://www.cms.gov/files/zip/new.zip")
        self.assertEqual(manifest["sources"][0]["sha256"], fetch.sha256(b"new bytes"))
        self.assertEqual((fetch.RAW / "addenda-2027" / "old.zip.prev").read_bytes(), b"old bytes")


class Replaced(unittest.TestCase):
    def test_changed_bytes_at_the_same_address_are_reported(self):
        sources = [
            {"id": "b-2026-10", "kind": "addendum_b", "effective": "2026-10-01", "url": "u1", "sha256": fetch.sha256(b"same")},
            {"id": "addenda-2027", "kind": "rule_addenda", "cy": 2027, "url": "u2", "sha256": fetch.sha256(b"old")},
            {"id": "addenda-2026", "kind": "rule_addenda", "cy": 2026, "url": "u3", "sha256": fetch.sha256(b"old")},
            {"id": "fr-1", "kind": "fr_text", "url": "u4", "sha256": "x"},
        ]
        new_rule = table_zip("2027 FR Addendum E.csv")
        served = {"u1": b"same", "u2": new_rule, "u3": new_rule, "u4": new_rule}
        changed, problems = refresh.replaced_in_place(sources, served.get)
        self.assertEqual([(source["id"], data) for source, data in changed], [("addenda-2027", new_rule)])
        self.assertEqual(problems, [])

    def test_an_error_page_at_the_old_address_is_a_problem_not_a_replacement(self):
        sources = [
            {"id": "b-2026-10", "kind": "addendum_b", "effective": "2026-10-01", "url": "u1", "sha256": "pinned"},
            {"id": "addenda-2027", "kind": "rule_addenda", "cy": 2027, "url": "u2", "sha256": "pinned"},
        ]
        served = {"u1": b"<html>Page not found</html>", "u2": table_zip("2027 FR Addendum E.csv")}
        changed, problems = refresh.replaced_in_place(sources, served.get, skip={"addenda-2027"})
        self.assertEqual(changed, [])
        self.assertEqual(len(problems), 1)
        self.assertIn("b-2026-10", problems[0])

    def test_malformed_candidates_are_rejected_not_fatal(self):
        utf16 = io.BytesIO()
        with zipfile.ZipFile(utf16, "w") as archive:
            archive.writestr("2026 Addendum B.txt", "HCPCS Code\tSI\n00100\tC\n".encode("utf-16"))
        for data in (b"", b"PK\x03\x04 truncated", utf16.getvalue(), table_zip("2026 Addendum B.csv", count=3)):
            self.assertFalse(refresh.is_table(data, "addendum_b"))

    def test_list_change_names_the_codes(self):
        old = table_zip("2026 October Addendum B.csv", count=60)
        new = table_zip("2026 October Addendum B.csv", count=62)
        line = refresh.list_change({"kind": "addendum_b"}, old, new)
        self.assertIn("+2", line)
        self.assertIn("00160", line)


class FollowUps(unittest.TestCase):
    def test_a_history_change_asks_for_a_crosswalk_rebuild(self):
        sources = fetch.load_sources()
        self.assertNotIn(refresh.CROSSWALK_NOTE, refresh.follow_ups(sources))
        self.assertIn(refresh.CROSSWALK_NOTE, refresh.follow_ups(sources, history_changed=True))
        self.assertIn("python3 pipeline/crosswalk/build.py", refresh.CROSSWALK_NOTE)


if __name__ == "__main__":
    unittest.main()
