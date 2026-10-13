#!/usr/bin/env python3
"""Build offline MinerU-style fixtures from Vibero's demo paper (stdlib only).

Usage: python3 test/build-fixture.py
Output: test/fixtures/demo/{demo_content_list.json, full.md, demo-paper.pdf, mineru-result.zip}
"""
import base64, collections, json, os, re, shutil, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, '.port-src', 'vibero')
OUT = os.path.join(ROOT, 'test', 'fixtures', 'demo')

# Smallest valid baseline JPEG (1x1 grey pixel)
JPEG_1X1 = base64.b64decode(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////'
    'wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=')


def main():
    d = json.load(open(os.path.join(SRC, 'demo-paper-vibedb.json'), encoding='utf-8'))
    md = d['markdownContent']
    md_images = re.findall(r'!\[[^\]]*\]\((images/[^)]+)\)', md)
    block_text = {}
    for s in d['blockMapping']:
        for b in s.get('blocks', []):
            block_text[int(b['minerUid'])] = b.get('text') or ''

    items = []  # (uid, item)
    seen = set()
    for page in d['hierarchicalData']:
        for p in page['paragraphs']:
            uid = int(p['minerUid']) if p.get('minerUid') is not None else 0  # main title has null uid
            bbox = p.get('bbox')
            if not bbox:
                continue
            seen.add(uid)
            t = p['paragraphType']
            pg = p.get('pageIndex', page['pageIndex'])
            text = p.get('paragraphText') or ''
            if t == 'title':
                it = {'type': 'text', 'text': text, 'text_level': 1, 'bbox': bbox, 'page_idx': pg}
            elif t == 'image':
                it = {'type': 'image', 'img_path': None, 'image_caption': [text] if text else [],
                      'image_footnote': [], 'bbox': bbox, 'page_idx': pg}
            elif t == 'table':
                it = {'type': 'table', 'img_path': None, 'table_caption': [text] if text else [],
                      'table_body': '', 'table_footnote': [], 'bbox': bbox, 'page_idx': pg}
            elif t == 'equation':
                it = {'type': 'equation', 'text': text, 'text_format': 'latex', 'bbox': bbox, 'page_idx': pg}
            elif t == 'list':
                lines = [re.sub(r'^\s*[•\-*]\s*', '', l).strip() for l in text.split('\n')]
                lines = [l for l in lines if l]
                it = {'type': 'list', 'sub_type': 'text', 'list_items': lines[1:] if len(lines) > 1 else lines,
                      'bbox': bbox, 'page_idx': pg}
            else:  # text, text_with_equation, ...
                it = {'type': 'text', 'text': text or block_text.get(uid, '').strip(), 'bbox': bbox, 'page_idx': pg}
            items.append((uid, it))
    # section titles from blockMapping that are not in hierarchicalData: only if they carry a bbox
    for s in d['blockMapping']:
        uid = int(s['minerUid'])
        if uid not in seen and s.get('bbox'):
            items.append((uid, {'type': 'text', 'text': s['title'], 'text_level': 1, 'bbox': s['bbox'],
                                'page_idx': s['page_idx']}))
    items.sort(key=lambda x: x[0])
    content = [it for _, it in items]

    # assign image paths
    img_files = []
    ii = ti = 0
    for it in content:
        if it['type'] == 'image':
            it['img_path'] = md_images[ii] if ii < len(md_images) else 'images/img_%d.jpg' % ii
            ii += 1
            img_files.append(it['img_path'])
        elif it['type'] == 'table':
            it['img_path'] = 'images/table_%d.jpg' % ti
            ti += 1
            img_files.append(it['img_path'])
    for m in md_images:
        if m not in img_files:
            img_files.append(m)

    os.makedirs(OUT, exist_ok=True)
    cl_json = json.dumps(content, ensure_ascii=False, indent=2)
    open(os.path.join(OUT, 'demo_content_list.json'), 'w', encoding='utf-8').write(cl_json)
    open(os.path.join(OUT, 'full.md'), 'w', encoding='utf-8').write(md)
    shutil.copyfile(os.path.join(SRC, 'demo-paper.pdf'), os.path.join(OUT, 'demo-paper.pdf'))
    with zipfile.ZipFile(os.path.join(OUT, 'mineru-result.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('demo_content_list.json', cl_json)
        z.writestr('full.md', md)
        for f in img_files:
            z.writestr(f, JPEG_1X1)

    pages = sorted({it['page_idx'] for it in content})
    cnt = collections.Counter(it['type'] for it in content)
    print('wrote', OUT)
    print('items: %d across %d pages (%s)' % (len(content), len(pages), ','.join(map(str, pages))))
    print('per type:', dict(cnt), '| titles:', sum(1 for i in content if i.get('text_level')))
    print('images in zip:', len(img_files))


if __name__ == '__main__':
    sys.exit(main())
