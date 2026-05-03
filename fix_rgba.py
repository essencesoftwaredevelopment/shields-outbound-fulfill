import re

filepath = "/Users/jacques/Documents/ESSENCE/Service Delivery/Projects/shields-outbound/app/clients/[clientId]/page.tsx"
with open(filepath, 'r') as f:
    content = f.read()

original = content

def rgba_255_pattern(alpha_re):
    return r'rgba\(255,\s*255,\s*255,\s*' + alpha_re + r'\)'

text_map = [
    (r'0\.96', 'var(--app-text)'),
    (r'0\.95', 'var(--app-text)'),
    (r'0\.9',  'var(--app-text-high)'),
    (r'0\.88', 'var(--app-text-high)'),
    (r'0\.85', 'var(--app-text-high)'),
    (r'0\.82', 'var(--app-text-high)'),
    (r'0\.8',  'var(--app-text-high)'),
    (r'0\.75', 'var(--app-text-mid)'),
    (r'0\.72', 'var(--app-text-muted)'),
    (r'0\.7',  'var(--app-text-muted)'),
    (r'0\.66', 'var(--app-text-muted)'),
    (r'0\.65', 'var(--app-text-muted)'),
    (r'0\.6',  'var(--app-text-muted)'),
    (r'0\.55', 'var(--app-text-faint)'),
    (r'0\.5',  'var(--app-text-ghost)'),
    (r'0\.45', 'var(--app-text-faint)'),
    (r'0\.4',  'var(--app-text-ghost)'),
    (r'0\.35', 'var(--app-text-ghost)'),
    (r'0\.3',  'var(--app-text-ghost)'),
    (r'0\.28', 'var(--app-text-ghost)'),
    (r'0\.25', 'var(--app-text-ghost)'),
]

bg_map = [
    (r'0\.18', 'var(--app-surface-hover)'),
    (r'0\.16', 'var(--app-surface-hover)'),
    (r'0\.15', 'var(--app-surface-2)'),
    (r'0\.12', 'var(--app-surface-2)'),
    (r'0\.1',  'var(--app-surface-2)'),
    (r'0\.08', 'var(--app-surface-3)'),
    (r'0\.07', 'var(--app-surface-3)'),
    (r'0\.06', 'var(--app-surface-3)'),
    (r'0\.05', 'var(--app-surface-3)'),
    (r'0\.04', 'var(--app-surface-3)'),
    (r'0\.03', 'var(--app-surface-3)'),
    (r'0\.02', 'var(--app-surface-3)'),
]

border_map = [
    (r'0\.25', 'var(--app-border-mid)'),
    (r'0\.2',  'var(--app-border-mid)'),
    (r'0\.15', 'var(--app-border-mid)'),
    (r'0\.12', 'var(--app-border-mid)'),
    (r'0\.1',  'var(--app-border)'),
    (r'0\.08', 'var(--app-border)'),
    (r'0\.06', 'var(--app-border)'),
]

def replace_color_prop(content, prop_names, alpha_re, replacement):
    prop_pattern = '|'.join(re.escape(p) for p in prop_names)
    rgba_pat = rgba_255_pattern(alpha_re)
    pattern = r"((?:" + prop_pattern + r")\s*:\s*['\"])" + rgba_pat + r"(['\"])"
    def repl(m):
        return m.group(1) + replacement + m.group(2)
    return re.sub(pattern, repl, content)

def replace_border_1px(content, alpha_re, replacement):
    rgba_pat = rgba_255_pattern(alpha_re)
    border_props = r'(?:border(?:Top|Bottom|Left|Right|Color)?)'
    pattern = r"(" + border_props + r"\s*:\s*['\"]1px solid )" + rgba_pat + r"(['\"])"
    def repl(m):
        return m.group(1) + replacement + m.group(2)
    return re.sub(pattern, repl, content)

def replace_border_template_1px(content, alpha_re, replacement):
    """Replace rgba in template literals like: `1px solid ${rgba...}` — tricky, skip for now"""
    return content

# Step 1: Fix text color props
for alpha_re, var in text_map:
    content = replace_color_prop(content, ['color'], alpha_re, var)

# Step 2: Fix background props
for alpha_re, var in bg_map:
    content = replace_color_prop(content, ['background', 'backgroundColor'], alpha_re, var)

# Step 3: Fix '1px solid rgba(...)' in border props
for alpha_re, var in border_map:
    content = replace_border_1px(content, alpha_re, var)

changed_lines = sum(1 for a, b in zip(original.splitlines(), content.splitlines()) if a != b)
print(f"Lines changed: {changed_lines}")

remaining = len(re.findall(r'rgba\(255,\s*255,\s*255', content))
print(f"Remaining rgba(255,255,255,...): {remaining}")

with open(filepath, 'w') as f:
    f.write(content)

print("Done.")
