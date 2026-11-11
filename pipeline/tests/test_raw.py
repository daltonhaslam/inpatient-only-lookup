"""Checks that need the raw CMS downloads. Skipped when data/raw/ is absent (a fresh clone)."""
import re
import unittest

import citations
import fetch
import history
import parse
RAW_PRESENT = fetch.RAW.is_dir() and any(fetch.RAW.iterdir())


def words(text):
    return re.findall(r"[a-z0-9]+", text.lower())


def shares_run(a, b, length):
    grams = {tuple(a[i:i + length]) for i in range(len(a) - length + 1)}
    return any(tuple(b[i:i + length]) in grams for i in range(len(b) - length + 1))


@unittest.skipUnless(RAW_PRESENT, "raw CMS files not downloaded; run pipeline/fetch.py")
class Raw(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources = fetch.load_sources()

    def test_every_file_matches_its_pin(self):
        for source in self.sources:
            self.assertEqual(fetch.sha256(fetch.raw_path(source).read_bytes()), source["sha256"], source["id"])

    def test_quotes_are_on_their_cited_pages(self):
        self.assertEqual(citations.verify(self.sources), [])

    def test_no_label_copies_a_cms_descriptor(self):
        """A label may not equal a CMS/AMA descriptor or share five consecutive words with one."""
        labels = fetch.read_json(fetch.ROOT / "data" / "labels.json")
        descriptors = {}
        for source in self.sources:
            for which, pattern in history.MEMBERS.get(source["kind"], {}).items():
                if which == "e":
                    continue    # Addendum E repeats the descriptors of the same rule's Addendum B
                path = fetch.raw_path(source)
                for code, texts in parse.descriptor_table(path, parse.pick_member(path, pattern)).items():
                    if code in labels:
                        descriptors.setdefault(code, set()).update(texts)
        self.assertEqual(set(descriptors), set(labels))
        copied = []
        for code, item in labels.items():
            label = words(item["label"])
            for text in descriptors[code]:
                theirs = words(text)
                if label == theirs or shares_run(label, theirs, 5):
                    copied.append(code)
                    break
        self.assertEqual(copied, [])


if __name__ == "__main__":
    unittest.main()
