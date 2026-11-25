"""Generate original, offline parser fixtures using only the standard library."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo

directory = Path(__file__).parent
content = b"BT /F1 12 Tf 36 80 Td (Offline fixture text.) Tj ET"
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
]
data = bytearray(b"%PDF-1.4\n")
offsets = []
for i, obj in enumerate(objects, 1):
    offsets.append(len(data))
    data.extend(b"%d 0 obj\n" % i + obj + b"\nendobj\n")
xref = len(data)
data.extend(b"xref\n0 6\n0000000000 65535 f \n")
for offset in offsets:
    data.extend(b"%010d 00000 n \n" % offset)
data.extend(b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % xref)
(directory / "tiny.pdf").write_bytes(data)

with ZipFile(directory / "tiny.docx", "w") as archive:
    for name, xml in {
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fixture</w:t></w:r></w:p></w:body></w:document>',
    }.items():
        archive.writestr(ZipInfo(name), xml, compress_type=ZIP_DEFLATED)
