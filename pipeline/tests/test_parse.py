import io
import os
import tempfile
import unittest
import zipfile

import parse

SHEET = """<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="B1" t="s"><v>0</v></c></row>
<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" t="s"><v>3</v></c><c r="D2" t="s"><v>4</v></c></row>
<row r="3"><c r="A3"><v>100</v></c><c r="B3" t="s"><v>5</v></c><c r="C3" t="s"><v>6</v></c><c r="D3"><v>5041.0</v></c></row>
<row r="4"><c r="A4" t="inlineStr"><is><t>0075T</t></is></c><c r="C4" t="s"><v>7</v></c></row>
%s
</sheetData></worksheet>"""
STRINGS = """<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<si><t>Addendum B</t></si><si><t>HCPCS Code</t></si><si><t>Short Descriptor</t></si><si><t>SI</t></si><si><t>APC</t></si>
<si><r><t>Some </t></r><r><t>text</t></r></si><si><t>j1</t></si><si><t>C</t></si></sst>"""
WORKBOOK = """<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="B" sheetId="1" r:id="rId1"/></sheets></workbook>"""
RELS = """<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"""


def padding(count):
    return "".join('<row r="%d"><c r="A%d"><v>%d</v></c><c r="C%d" t="s"><v>6</v></c></row>' % (i, i, 20000 + i, i) for i in range(10, 10 + count))


def workbook_zip(directory, sheet=None, strings=STRINGS):
    book = io.BytesIO()
    with zipfile.ZipFile(book, "w") as z:
        z.writestr("xl/workbook.xml", WORKBOOK)
        z.writestr("xl/_rels/workbook.xml.rels", RELS)
        z.writestr("xl/sharedStrings.xml", strings)
        z.writestr("xl/worksheets/sheet1.xml", sheet or SHEET % padding(60))
    path = os.path.join(directory, "outer.zip")
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("2099 Addendum B.xlsx", book.getvalue())
        z.writestr("508 version/2099 Addendum B.csv", "x")
    return path


class Parse(unittest.TestCase):
    def test_normalize_code(self):
        self.assertEqual(parse.normalize_code("100"), "00100")
        self.assertEqual(parse.normalize_code(" 27447.0 "), "27447")
        self.assertEqual(parse.normalize_code("0075t"), "0075T")
        self.assertEqual(parse.normalize_code("g0412"), "G0412")

    def test_workbook_is_read_without_descriptors(self):
        with tempfile.TemporaryDirectory() as directory:
            path = workbook_zip(directory)
            member = parse.pick_member(path, r"addendum[ _-]*b(?![a-z])")
            self.assertTrue(member.endswith(".xlsx"))
            table = parse.code_table(path, member)
        self.assertEqual(table["00100"], "J1")
        self.assertEqual(table["0075T"], "C")
        self.assertNotIn("Some text", str(table))

    def test_text_copy_is_picked_when_asked(self):
        with tempfile.TemporaryDirectory() as directory:
            path = workbook_zip(directory)
            self.assertTrue(parse.pick_member(path, r"addendum[ _-]*b(?![a-z])", prefer_spreadsheet=False).endswith(".csv"))

    def test_conflicting_status_for_one_code_is_an_error(self):
        clash = SHEET % (padding(60) + '<row r="90"><c r="A90"><v>100</v></c><c r="C90" t="s"><v>7</v></c></row>')
        with tempfile.TemporaryDirectory() as directory:
            path = workbook_zip(directory, sheet=clash)
            with self.assertRaises(parse.ParseError):
                parse.code_table(path, "2099 Addendum B.xlsx")

    def test_tiny_table_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = workbook_zip(directory, sheet=SHEET % "")
            with self.assertRaises(parse.ParseError):
                parse.code_table(path, "2099 Addendum B.xlsx")

    def test_workbook_part_with_entities_is_refused(self):
        evil = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]>' + STRINGS.split("?>", 1)[1]
        with tempfile.TemporaryDirectory() as directory:
            path = workbook_zip(directory, strings=evil)
            with self.assertRaises(parse.ParseError):
                parse.code_table(path, "2099 Addendum B.xlsx")

    def test_utf16_workbook_part_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = workbook_zip(directory, strings=STRINGS.encode("utf-16"))
            with self.assertRaises(parse.ParseError):
                parse.code_table(path, "2099 Addendum B.xlsx")

    def test_tab_delimited_text_with_title_rows(self):
        rows = ["\tAddendum E\t\t", "HCPCS Code\tShort Descriptor\tCI\tSI"] + ["%05d\tx\t\tC" % n for n in range(100, 160)]
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "e.zip")
            with zipfile.ZipFile(path, "w") as z:
                z.writestr("2099 Addendum E.txt", "\n".join(rows).encode("cp1252"))
            table = parse.code_table(path, parse.pick_member(path, r"addendum[ _-]*e(?![a-z])"))
        self.assertEqual(len(table), 60)
        self.assertEqual(table["00100"], "C")


if __name__ == "__main__":
    unittest.main()
