"""Read CMS's OPPS addenda (xlsx, csv or tab-delimited txt inside a zip) into {code: status indicator}.

Only the code and its status indicator are kept. Descriptor columns are AMA-copyrighted and are
dropped here, so nothing downstream of this module can publish them. Standard library only.
"""
import csv
import functools
import io
import re
import zipfile
import xml.etree.ElementTree as ET

CODE_RE = re.compile(r"^[0-9A-Z][0-9]{3}[0-9A-Z]$")
MAX_MEMBER_BYTES = 80 * 1024 * 1024
MIN_CODES = 50   # the smallest real table (a removal file) has several hundred
_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
_REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


class ParseError(ValueError):
    pass


def _column_index(cell_ref):
    index = 0
    for char in cell_ref:
        if not char.isalpha():
            break
        index = index * 26 + (ord(char.upper()) - 64)
    return index - 1


def _read(archive, name):
    """Read one zip member, refusing oversized members (a zip bomb would be one)."""
    if archive.getinfo(name).file_size > MAX_MEMBER_BYTES:
        raise ParseError("%s is larger than %d bytes" % (name, MAX_MEMBER_BYTES))
    return archive.read(name)


def _xml(archive, name):
    """Parse a workbook part. Spreadsheet XML has no DTD; one that declares entities is refused."""
    data = _read(archive, name)
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise ParseError("%s declares a DTD or entities" % name)
    return ET.fromstring(data)


def _xlsx_sheets(archive):
    """Yield (sheet name, rows) for every worksheet, in workbook order."""
    shared = []
    if "xl/sharedStrings.xml" in archive.namelist():
        root = _xml(archive, "xl/sharedStrings.xml")
        for item in root.findall("m:si", _NS):
            shared.append("".join(node.text or "" for node in item.iter("{%s}t" % _NS["m"])))
    workbook = _xml(archive, "xl/workbook.xml")
    rels = _xml(archive, "xl/_rels/workbook.xml.rels")
    targets = {rel.get("Id"): rel.get("Target") for rel in rels}
    for sheet in workbook.find("m:sheets", _NS):
        target = targets[sheet.get(_REL_NS + "id")].lstrip("/")
        path = target if target.startswith("xl/") else "xl/" + target
        root = _xml(archive, path)
        rows = []
        for row in root.iter("{%s}row" % _NS["m"]):
            cells = []
            for cell in row.findall("m:c", _NS):
                index = _column_index(cell.get("r") or "")
                if index < 0:
                    index = len(cells)
                kind = cell.get("t")
                if kind == "inlineStr":
                    text = "".join(node.text or "" for node in cell.iter("{%s}t" % _NS["m"]))
                else:
                    value = cell.find("m:v", _NS)
                    text = value.text if value is not None and value.text else ""
                    if kind == "s" and text:
                        text = shared[int(text)]
                while len(cells) <= index:
                    cells.append("")
                cells[index] = text
            rows.append(cells)
        yield sheet.get("name"), rows


def _decode(data):
    """CMS's text copies are UTF-8 or Windows-1252; Latin-1 decodes anything left."""
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def read_member(zip_path, member):
    """Return a list of (sheet name, rows); text files have one unnamed sheet."""
    with zipfile.ZipFile(zip_path) as archive:
        lower = member.lower()
        if lower.endswith((".xlsx", ".xlsm")):
            with zipfile.ZipFile(io.BytesIO(_read(archive, member))) as book:
                return list(_xlsx_sheets(book))
        text = _decode(_read(archive, member))
        delimiter = "\t" if lower.endswith(".txt") else ","
        return [("", list(csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)))]


def pick_member(zip_path, pattern, prefer_spreadsheet=True):
    """The member whose basename matches pattern: the workbook, or its text copy if asked or if there
    is no workbook. More than one workbook or text copy matching is an error."""
    regex = re.compile(pattern, re.I)
    with zipfile.ZipFile(zip_path) as archive:
        names = [name for name in archive.namelist() if regex.search(name.rsplit("/", 1)[-1])]
    books = [name for name in names if name.lower().endswith((".xlsx", ".xlsm"))]
    texts = [name for name in names if name.lower().endswith((".txt", ".csv"))]
    if len(books) > 1 or len(texts) > 1:
        raise ParseError("more than one member matching %r in %s: %s" % (pattern, zip_path, books + texts))
    ordered = (books + texts) if prefer_spreadsheet else (texts + books)
    if not ordered:
        raise ParseError("no member matching %r in %s" % (pattern, zip_path))
    return ordered[0]


def normalize_code(text):
    """CMS stores some all-digit codes as numbers ('100' or '100.0' for 00100)."""
    value = (text or "").strip().upper()
    if re.fullmatch(r"\d{1,5}(\.0+)?", value):
        value = value.split(".")[0].zfill(5)
    return value


_HEADERS = {
    "code": re.compile(r"^(cy\s*\d{4}\s*)?(hcpcs|cpt)(\s*/\s*cpt)?\s*code$", re.I),
    "si": re.compile(r"^(cy\s*\d{4}\s*)?(opps\s*)?(si|status\s*indicator)$", re.I),
}


def _find_header(rows):
    """(row number, {"code": column, "si": column}) of the header row, or (None, None)."""
    for number, row in enumerate(rows[:40]):
        found = {}
        for index, cell in enumerate(row):
            label = re.sub(r"\s+", " ", cell or "").strip()
            for key, regex in _HEADERS.items():
                if key not in found and regex.match(label):
                    found[key] = index
        if len(found) == len(_HEADERS):
            return number, found
    return None, None


def _cell(row, index):
    return (row[index] or "").strip() if index < len(row) else ""


@functools.lru_cache(maxsize=None)
def code_table(zip_path, member):
    """Parse one addendum into {code: status indicator}. Treat the result as read-only: it is cached.

    Raises ParseError when no sheet has a code and status-indicator header, when a code repeats
    with a different status indicator, or when the table is implausibly small.
    """
    table = {}
    parsed_any = False
    for _, rows in read_member(zip_path, member):
        header_row, columns = _find_header(rows)
        if columns is None:
            continue
        parsed_any = True
        for row in rows[header_row + 1:]:
            code = normalize_code(_cell(row, columns["code"]))
            if not CODE_RE.match(code):
                continue
            si = _cell(row, columns["si"]).upper()
            if table.setdefault(code, si) != si:
                raise ParseError("%s: %s listed with status %s and %s" % (member, code, table[code], si))
    if not parsed_any:
        raise ParseError("no code/status-indicator header found in %s" % member)
    if len(table) < MIN_CODES:
        raise ParseError("only %d codes parsed from %s" % (len(table), member))
    return table


_DESCRIPTOR_HEADER = re.compile(r"descriptor|description", re.I)


def descriptor_table(zip_path, member):
    """{code: [descriptor text, ...]} for LOCAL checks only.

    CMS's descriptors are AMA-copyrighted. This exists so the label tests can prove that no
    plain-language label copies one. Never write its output to a tracked or published file.
    """
    table = {}
    for _, rows in read_member(zip_path, member):
        header_row, columns = _find_header(rows)
        if columns is None:
            continue
        wanted = [i for i, cell in enumerate(rows[header_row]) if _DESCRIPTOR_HEADER.search(cell or "")]
        for row in rows[header_row + 1:]:
            code = normalize_code(_cell(row, columns["code"]))
            if CODE_RE.match(code):
                table[code] = [row[i].strip() for i in wanted if i < len(row) and row[i].strip()]
    return table
