"""Checks that need the raw CMS downloads. Skipped when data/raw/ is absent (a fresh clone)."""
import unittest

import citations
import fetch
import history
import parse
from crosswalk.checks import words
RAW_PRESENT = fetch.RAW.is_dir() and any(fetch.RAW.iterdir())


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
        """A label may not equal its own code's CMS/AMA descriptor, or share five consecutive words
        with ANY code's descriptor (a label can echo a sibling code's wording)."""
        labels = fetch.read_json(fetch.ROOT / "data" / "labels.json")
        descriptors = {}
        for source in self.sources:
            for which, pattern in history.MEMBERS.get(source["kind"], {}).items():
                if which == "e":
                    continue    # Addendum E repeats the descriptors of the same rule's Addendum B
                path = fetch.raw_path(source)
                for code, texts in parse.descriptor_table(path, parse.pick_member(path, pattern)).items():
                    descriptors.setdefault(code, set()).update(texts)
        self.assertEqual(set(labels) - set(descriptors), set())
        runs = {tuple(found[i:i + 5]) for texts in descriptors.values() for text in texts
                for found in [words(text)] for i in range(len(found) - 4)}
        copied = []
        for code, item in labels.items():
            label = words(item["label"])
            if any(label == words(text) for text in descriptors[code]) or any(
                    tuple(label[i:i + 5]) in runs for i in range(len(label) - 4)):
                copied.append(code)
        self.assertEqual(copied, [])


if __name__ == "__main__":
    unittest.main()
