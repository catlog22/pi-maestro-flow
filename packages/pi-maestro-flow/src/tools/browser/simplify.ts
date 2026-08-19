/**
 * Browser DOM probe utilities, ported from GenericAgent's simphtml.py.
 *
 * The browser-side JS (PROBE_JS / FIND_LISTS_JS / MONITOR_*) is a near-verbatim
 * port of the Python original (raw string → TS template, True→true, None→null),
 * preserving the visibility/overlay/partition/iframe/shadow detection and the
 * list-scoring algorithm. One intentional deviation: the original never calls
 * WeakMap.set on `nodeInfo`, so its overlay/partition analysis is dead code;
 * this port adds `nodeInfo.set(clone, info)` so the container collapsing logic
 * actually runs. The host-side post-processing (token optimization, truncation,
 * diff) is reimplemented at the string level because Node has no BeautifulSoup
 * equivalent; behavior is aligned, implementation simplified to avoid pulling in
 * a DOM dependency.
 */

/**
 * optHTML: builds an enhanced DOM copy of <body> that filters invisible nodes,
 * collapses overlay/partition containers, pierces iframes and shadow roots,
 * preserves form values/checked/autofill markers, and returns simplified HTML.
 *
 * Ported from simphtml.py js_optHTML (text_only branch dropped — the
 * host uses extract("text") for plain text instead).
 */
export const PROBE_JS = `(function() {
function optHTML() {
  const nodeInfo = new WeakMap();
  const ignoreTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'COLGROUP', 'COL', 'TEMPLATE', 'PARAM', 'SOURCE'];
  const ignoreIds = ['ljq-ind'];
  function cloneNode(sourceNode, keep=false) {
    if (sourceNode.nodeType === 8 ||
        (sourceNode.nodeType === 1 && (
          ignoreTags.includes(sourceNode.tagName) ||
          (sourceNode.id && ignoreIds.includes(sourceNode.id))
        ))) {
      return null;
    }
    if (sourceNode.nodeType === 3) return sourceNode.cloneNode(false);
    const clone = sourceNode.cloneNode(false);
    if ((sourceNode.tagName === 'INPUT' || sourceNode.tagName === 'TEXTAREA') && sourceNode.value) clone.setAttribute('value', sourceNode.value);
    if (sourceNode.tagName === 'INPUT' && (sourceNode.type === 'radio' || sourceNode.type === 'checkbox') && sourceNode.checked) clone.setAttribute('checked', '');
    else if (sourceNode.tagName === 'SELECT' && sourceNode.value) clone.setAttribute('data-selected', sourceNode.value);
    try { if (sourceNode.matches && sourceNode.matches(':-webkit-autofill')) { clone.setAttribute('data-autofilled', 'true'); if (!sourceNode.value) clone.setAttribute('value', 'Protected-read autofill SOP to extract value'); } } catch(e) {}

    const isDropdown = sourceNode.classList?.contains('dropdown-menu') ||
             /dropdown|menu/i.test(sourceNode.className) || sourceNode.getAttribute('role') === 'menu';
    const _ddItems = isDropdown ? sourceNode.querySelectorAll('a, button, [role="menuitem"], li').length : 0;
    const isSmallDropdown = _ddItems > 0 && _ddItems <= 7 && sourceNode.textContent.length < 500;

    const childNodes = [];
    for (const child of sourceNode.childNodes) {
      const childClone = cloneNode(child, keep || isSmallDropdown);
      if (childClone) childNodes.push(childClone);
    }
    if (sourceNode.tagName === 'IFRAME') {
      try {
        const iDoc = sourceNode.contentDocument || sourceNode.contentWindow?.document;
        if (iDoc && iDoc.body && iDoc.body.children.length > 0) {
          const wrapper = document.createElement('div');
          wrapper.setAttribute('data-iframe-content', sourceNode.src || '');
          for (const ch of iDoc.body.childNodes) {
            const c = cloneNode(ch, keep);
            if (c) wrapper.appendChild(c);
          }
          if (wrapper.childNodes.length) childNodes.push(wrapper);
        }
      } catch(e) {}
    }
    if (sourceNode.shadowRoot) {
      for (const shadowChild of sourceNode.shadowRoot.childNodes) {
        const shadowClone = cloneNode(shadowChild, keep);
        if (shadowClone) childNodes.push(shadowClone);
      }
    }

    const rect = sourceNode.getBoundingClientRect();
    const style = window.getComputedStyle(sourceNode);
    const area = (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) <= 0)?0:rect.width * rect.height;
    const isVisible = (rect.width > 1 && rect.height > 1 &&
                  style.display !== 'none' && style.visibility !== 'hidden' &&
                  parseFloat(style.opacity) > 0 &&
                  Math.abs(rect.left) < 5000 && Math.abs(rect.top) < 5000)
                  || isSmallDropdown;
    const zIndex = style.position !== 'static' ? (parseInt(style.zIndex) || 0) : 0;

    let info = {
          rect, area, isVisible, isSmallDropdown, zIndex,
          style: {
            display: style.display, visibility: style.visibility,
            opacity: style.opacity, position: style.position
          }};

    const nonTextChildren = childNodes.filter(child => child.nodeType !== 3);
    const hasValidChildren = nonTextChildren.length > 0;

    if (hasValidChildren) {
      const childrenInfos = nonTextChildren.map(c => nodeInfo.get(c)).filter(i => i && i.rect && i.rect.width > 0 && i.rect.height > 0);
      const bgAlpha = (() => {
        const c = style.backgroundColor;
        if (!c || c === 'transparent') return 0;
        const m = c.match(/rgba?\\([^)]+,\\s*([\\d.]+)\\)/);
        return m ? parseFloat(m[1]) : 1;
      })();
      const hasVisualBg = bgAlpha > 0.1 || style.backgroundImage !== 'none' || (style.backdropFilter && style.backdropFilter !== 'none') || style.boxShadow !== 'none';

      if (!hasVisualBg && childrenInfos.length > 0) {
        const flowChildren = childrenInfos.filter(cInfo => cInfo.style && cInfo.style.position !== 'fixed' && cInfo.style.position !== 'absolute');
        if (flowChildren.length > 0) {
          let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
          for (const cInfo of flowChildren) {
            minL = Math.min(minL, cInfo.rect.left);
            minT = Math.min(minT, cInfo.rect.top);
            maxR = Math.max(maxR, cInfo.rect.right);
            maxB = Math.max(maxB, cInfo.rect.bottom);
          }
          info.rect = { left: minL, top: minT, right: maxR, bottom: maxB, width: maxR - minL, height: maxB - minT };
          info.area = info.rect.width * info.rect.height;
        } else {
          const maxC = childrenInfos.filter(i => i.isVisible).sort((a, b) => b.area - a.area)[0];
          if (maxC && maxC.area > 10000 && (!isVisible || maxC.area > info.area * 5)) info = maxC;
        }
      }
    }

    if (sourceNode.nodeType === 1 && sourceNode.tagName === 'DIV') {
      if (!hasValidChildren && !sourceNode.textContent.trim()) return null;
    }
    if (sourceNode.getAttribute && sourceNode.getAttribute('aria-hidden') === 'true' && !info.isVisible) {
      return null;
    }
    if (info.isVisible || hasValidChildren || keep) {
      childNodes.forEach(child => clone.appendChild(child));
      nodeInfo.set(clone, info);
      return clone;
    }
    return null;
  }

  const domCopy = cloneNode(document.body);
  if (!domCopy) return '';

  function hasOverlapRects(items) {
    return items.some((a, i) =>
      items.slice(i+1).some(b => {
        const r1 = a.rect, r2 = b.rect;
        if (!r1.width || !r2.width || !r1.height || !r2.height) {return false;}
        const epsilon = 1;
        return !(r1.left + r1.width <= r2.left + epsilon || r1.left >= r2.left + r2.width - epsilon ||
            r1.top + r1.height <= r2.top + epsilon || r1.top >= r2.top + r2.height - epsilon
        );
      })
    );
  }

  const viewportArea = window.innerWidth * window.innerHeight;

  function containsButton(container) {
    const hasStandardButton = container.querySelector('button, input[type="button"], input[type="submit"], [role="button"]') !== null;
    if (hasStandardButton) return true;
    const hasClassButton = container.querySelector('[class*="-btn"], [class*="-button"], .button, .btn, [class*="btn-"]') !== null;
    return hasClassButton;
  }

  function handlePartitionContainer(childrenInfo, pathType) {
    childrenInfo.sort((a, b) => b.area - a.area);
    const totalArea = childrenInfo.reduce((sum, item) => sum + item.area, 0);
    const hasMainElement = childrenInfo.length >= 1 &&
                          (childrenInfo[0].area / totalArea > 0.5) &&
                          (childrenInfo.length === 1 || childrenInfo[0].area > childrenInfo[1].area * 2);
    if (hasMainElement) {
      childrenInfo[0].node.dataset.mark = 'K:main';
      for (let i = 1; i < childrenInfo.length; i++) {
        const child = childrenInfo[i];
        let className = (child.node.getAttribute('class') || '').toLowerCase();
        let isSecondary = containsButton(child.node);
        if (className.includes('nav')) isSecondary = true;
        if (className.includes('breadcrumbs')) isSecondary = true;
        if (className.includes('header') && className.includes('table')) isSecondary = true;
        if (child.node.innerHTML.trim().replace(/\\s+/g, '').length < 500) isSecondary = true;
        if (child.node.textContent.trim().length > 200) isSecondary = true;
        if (child.style.visibility === 'hidden') isSecondary = false;
        if (isSecondary) child.node.dataset.mark = 'K:secondary';
        else child.node.dataset.mark = 'K:nonEssential';
      }
    }
  }

  function handleOverlayContainer(childrenInfo, pathType) {
    const _efp = document.elementFromPoint(window.innerWidth/2, window.innerHeight/2);
    if (_efp) { let _el = _efp; while (_el) { const _h = childrenInfo.find(c => c.node.id && c.node.id === _el.id); if (_h) { _h.zIndex = 9999; break; } _el = _el.parentElement; } }
    const sorted = [...childrenInfo].sort((a, b) => b.zIndex - a.zIndex);
    if (sorted.length === 0) return;

    const top = sorted[0];
    const rect = top.rect;
    const topNode = top.node;
    const isComplex = top.node.querySelectorAll('input, select, textarea, button, a, [role="button"]').length >= 1;

    const textContent = topNode.textContent?.trim() || '';
    const textLength = textContent.length;
    const hasLinks = topNode.querySelectorAll('a').length > 0;
    const isMostlyText = textLength > 7 && !hasLinks;

    const centerDiff = Math.abs((rect.left + rect.width/2) - window.innerWidth/2) / window.innerWidth;
    const minDimensionRatio = Math.min(rect.width / window.innerWidth, rect.height / window.innerHeight);
    const maxDimensionRatio = Math.max(rect.width / window.innerWidth, rect.height / window.innerHeight);
    const isNearTop = rect.top < 50;
    const isDialog = (top.node.querySelector('iframe') || top.node.querySelector('button') || top.node.querySelector('input')) && centerDiff < 0.3;

    if (isComplex && centerDiff < 0.2 &&
        ((minDimensionRatio > 0.2 && rect.width/window.innerWidth < 0.98) || minDimensionRatio > 0.95)) {
      top.node.dataset.mark = 'K:mainInteractive';
       sorted.slice(1).forEach(e => {
          if ((parseInt(e.zIndex)||0) <= (parseInt(sorted[0].zIndex)||0)) {
              e.node.dataset.mark = 'R:covered';
          } else {
              e.node.dataset.mark = 'K:noncovered';
          }
      });
    } else {
      if (isComplex && isNearTop && maxDimensionRatio > 0.4 && top.isVisible) {
        top.node.dataset.mark = 'K:topBar';
      } else if (isMostlyText || isComplex || isDialog) {
        topNode.dataset.mark = 'K:messageContent';
      } else {
        topNode.dataset.mark = 'R:floatingAd';
      }
      const rest = sorted.slice(1);
      rest.length && (!hasOverlapRects(rest) ? handlePartitionContainer(rest, pathType) : handleOverlayContainer(rest, pathType));
    }
  }

  function analyzeNode(node, pPathType='main') {
    if (node.nodeType !== 1 || !node.children.length) {
      node.nodeType === 1 && (node.dataset.mark = 'K:leaf');
      return;
    }
    const pathType = (node.dataset.mark === 'K:secondary') ? 'second' : pPathType;
    const nodeInfoData = nodeInfo.get(node);
    if (!nodeInfoData || !nodeInfoData.rect) return;
    const rectn = nodeInfoData.rect;
    if (rectn.width < window.innerWidth * 0.8 && rectn.height < window.innerHeight * 0.8) return;
    if (node.tagName === 'TABLE') return;
    const children = Array.from(node.children);
    if (children.length === 1) {
      node.dataset.mark = 'K:container';
      return analyzeNode(children[0], pathType);
    }
    if (children.length > 10) return;

    const childrenInfo = children.map(child => {
      const info = nodeInfo.get(child) || { rect: {}, style: {} };
      return { node: child, rect: info.rect, style: info.style,
          area: info.area, zIndex: (info.zIndex || 0), isVisible: info.isVisible };
    });
    childrenInfo.sort((a, b) => b.area - a.area);

    const isOverlay = hasOverlapRects(childrenInfo);
    node.dataset.mark = isOverlay ? 'K:overlayParent' : 'K:partitionParent';

    if (isOverlay) handleOverlayContainer(childrenInfo, pathType);
    else handlePartitionContainer(childrenInfo, pathType);

    for (const child of children)
      if (!child.dataset.mark || child.dataset.mark[0] !== 'R') analyzeNode(child, pathType);
  }

  // Hoist top 1-2 deep fixed dialogs to body level for overlay detection
  const _fc = [...domCopy.querySelectorAll('*')].filter(el => {
    if (el.parentNode === domCopy) return false;
    const info = nodeInfo.get(el);
    if (!info?.rect || info.style.position !== 'fixed') return false;
    const r = info.rect, cover = (r.width * r.height) / viewportArea;
    const cd = Math.abs((r.left + r.width/2) - window.innerWidth/2) / window.innerWidth;
    return cover > 0.15 && cover < 1.0 && cd < 0.3 && el.querySelector('button, input, a, [role="button"], iframe');
  }).filter((el, _, arr) => !arr.some(o => o !== el && o.contains(el)))
    .sort((a, b) => (nodeInfo.get(b).rect.width * nodeInfo.get(b).rect.height) - (nodeInfo.get(a).rect.width * nodeInfo.get(a).rect.height))
    .slice(0, 2);
  _fc.forEach(el => { el.parentNode.removeChild(el); domCopy.appendChild(el); });
  analyzeNode(domCopy);
  domCopy.querySelectorAll('[data-mark^="R:"]').forEach(el=>el.parentNode?.removeChild(el));
  let root = domCopy;
  while (root.children.length === 1) {
    root = root.children[0];
  }
  for (let ii = 0; ii < 3; ii++) {
    root.querySelectorAll('div').forEach(div => (!div.textContent.trim() && div.children.length === 0) && div.remove());
  }
  root.querySelectorAll('[data-mark]').forEach(e => e.removeAttribute('data-mark'));
  root.removeAttribute('data-mark');
  root.querySelectorAll('iframe').forEach(f => {
    if (f.children.length) {
      const d = document.createElement('div');
      for (const a of f.attributes) d.setAttribute(a.name, a.value);
      d.setAttribute('data-tag', 'iframe');
      while (f.firstChild) d.appendChild(f.firstChild);
      f.parentNode.replaceChild(d, f);
    }
  });
  return root.outerHTML;
}

return optHTML();
})();`;

/**
 * findMainList: discovers repetitive list containers and scores them. Returns a
 * list of { containerId, containerClass, itemCount, selector, score, firstItemPreview }.
 * Ported verbatim from simphtml.py js_findMainList.
 */
export const FIND_LISTS_JS = `(function() {
function findMainList(startElement = null) {
        const root = startElement || document.body;
        const MIN_CHILDREN = 8;
        const MAX_CONTAINERS = 20;

        const candidates = [];
        const allEls = root.querySelectorAll('*');
        for (const node of allEls) {
            if (node.closest('svg')) continue;
            const l1 = node.children.length;
            if (l1 < 5) continue;
            let l2 = 0;
            for (const child of node.children) l2 += child.children.length;
            const score = l1 + l2 * 0.1;
            if (score >= MIN_CHILDREN) candidates.push({node, score});
        }
        candidates.sort((a, b) => b.score - a.score);
        const toProcess = candidates.slice(0, MAX_CONTAINERS).map(c => c.node);

        let allCandidates = [];
        for (const container of toProcess) {
            const topGroups = findTopGroups(container, 3);
            for (const groupInfo of topGroups) {
                const items = findMatchingElements(container, groupInfo.selector);
                if (items.length >= 5) {
                    const score = scoreContainer(container, items) + groupInfo.score;
                    if (score >= 30) {
                        allCandidates.push({ container, selector: groupInfo.selector, items, score });
                    }
                }
            }
        }

        allCandidates.sort((a, b) => b.score - a.score);

        const kept = [];
        for (const cand of allCandidates) {
            let dominated = false;
            for (const k of kept) {
                if (k.container.contains(cand.container) || cand.container.contains(k.container)) {
                    const kSet = new Set(k.items);
                    const overlap = cand.items.filter(it => kSet.has(it)).length;
                    if (overlap > cand.items.length * 0.5) { dominated = true; break; }
                }
            }
            if (!dominated) kept.push(cand);
        }

        function describeResult(container, items, selector, score) {
            if(container&&!container.id)container.id='_ljq'+(window._lci=(window._lci||0)+1);
            const cTag = container ? container.tagName : null;
            const cId = container ? (container.id || '') : '';
            const cClass = container ? (String(container.className || '').trim()) : '';
            const result = {
                containerTag: cTag, containerId: cId, containerClass: cClass,
                itemCount: items.length,
            };
            let prefix = '';
            if (cId) prefix = '#' + CSS.escape(cId);
            if (selector) result.selector = prefix ? (prefix + ' > ' + selector) : selector;
            if (score !== undefined) result.score = score;
            if (items.length > 0) {
                result.firstItemPreview = items[0].outerHTML.substring(0, 200);
                result.itemTags = items.slice(0, 10).map(el => el.tagName + (el.className ? '.' + String(el.className).trim().split(/\\s+/)[0] : ''));
            }
            return result;
        }

        if (kept.length === 0) return [];

        return kept.map(c => describeResult(c.container, c.items, c.selector, c.score));
    }

    function findTopGroups(container, limit) {
        const children = Array.from(container.children).filter(c => !c.closest('svg'));
        const totalChildren = children.length;
        if (totalChildren < 3) return [];

        const minGroupSize = Math.max(3, Math.floor(totalChildren * 0.2));
        const groups = [];

        const tagFreq = {}, classFreq = {}, tagMap = {}, classMap = {};

        children.forEach(child => {
            const tag = child.tagName.toLowerCase();
            if (tag === "td") return;
            tagFreq[tag] = (tagFreq[tag] || 0) + 1;
            if (!tagMap[tag]) tagMap[tag] = [];
            tagMap[tag].push(child);

            if (child.className) {
                child.className.trim().split(/\\s+/).forEach(cls => {
                    if (cls) {
                        classFreq[cls] = (classFreq[cls] || 0) + 1;
                        if (!classMap[cls]) classMap[cls] = [];
                        classMap[cls].push(child);
                    }
                });
            }
        });

        const scoreGroup = (selector, elements) => {
            const coverage = elements.length / totalChildren;
            let specificity = selector.startsWith('.')
            ? (0.6 + (selector.match(/\\./g).length - 1) * 0.1)
            : (selector.includes('.')
               ? (0.7 + (selector.match(/\\./g).length) * 0.1)
               : 0.3);
            return (coverage * 0.5) + (specificity * 0.5);
        };

        Object.keys(tagFreq).forEach(tag => {
            if (tag !== "div" && tagFreq[tag] >= minGroupSize) {
                groups.push({
                    selector: tag,
                    elements: tagMap[tag],
                    score: scoreGroup(tag, tagMap[tag]) - 0.5
                });
            }
        });

        Object.keys(classFreq).forEach(cls => {
            if (classFreq[cls] >= minGroupSize) {
                const selector = '.' + CSS.escape(cls);
                groups.push({
                    selector,
                    elements: classMap[cls],
                    score: scoreGroup(selector, classMap[cls])
                });
            }
        });
        const topTags = Object.keys(tagFreq).filter(t => tagFreq[t] >= minGroupSize).slice(0, 3);
        const topClasses = Object.keys(classFreq).filter(c => classFreq[c] >= minGroupSize).sort((a, b) => classFreq[b] - classFreq[a]).slice(0, 3);

        topTags.forEach(tag => {
            topClasses.forEach(cls => {
                const elements = children.filter(el =>
                                                 el.tagName.toLowerCase() === tag &&
                                                 el.className && el.className.split(/\\s+/).includes(cls)
                                                );

                if (elements.length >= minGroupSize) {
                    const selector = tag + '.' + CSS.escape(cls);
                    groups.push({selector, elements, score: scoreGroup(selector, elements)});
                }
            });
        });

        for (let i = 0; i < topClasses.length; i++) {
            for (let j = i + 1; j < topClasses.length; j++) {
                const elements = children.filter(el =>
                                                 el.className && el.className.split(/\\s+/).includes(topClasses[i]) && el.className.split(/\\s+/).includes(topClasses[j]));

                if (elements.length >= minGroupSize) {
                    const selector = '.' + CSS.escape(topClasses[i]) + '.' + CSS.escape(topClasses[j]);
                    groups.push({selector, elements,score: scoreGroup(selector, elements)});
                }
            }
        }
        return groups.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    function findMatchingElements(container, selector) {
        try {
            return Array.from(container.querySelectorAll(selector));
        } catch (e) {
            return [];
        }
    }

    function scoreContainer(container, items) {
        if (!container || items.length < 3) return 0;
        const containerRect = container.getBoundingClientRect();
        const containerArea = containerRect.width * containerRect.height;
        if (containerArea < 10000) return 0;

        const itemAreas = [];
        let totalItemArea = 0;
        let visibleItems = 0;

        items.forEach(item => {
            const rect = item.getBoundingClientRect();
            const area = rect.width * rect.height;
            if (area > 0) {
                totalItemArea += area;
                itemAreas.push(area);
                visibleItems++;
            }
        });
        if (visibleItems < 3) return 0;
        totalItemArea = Math.min(totalItemArea, containerArea * 0.98);
        const areaRatio = totalItemArea / containerArea;
        const areaScore = 40 / (1 + Math.exp(-12 * (areaRatio - 0.4)));

        let uniformityScore = 0;
        if (itemAreas.length >= 3) {
            const mean = itemAreas.reduce((sum, area) => sum + area, 0) / itemAreas.length;
            const variance = itemAreas.reduce((sum, area) => sum + Math.pow(area - mean, 2), 0) / itemAreas.length;
            const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
            uniformityScore = 20 * Math.exp(-2.5 * cv);
        }

        const baseScore = Math.log2(visibleItems) * 5 + Math.floor(visibleItems / 5) * 0.25;
        const rawCountScore = Math.min(40, baseScore);
        const countScore = rawCountScore * Math.max(0.1, uniformityScore / 20);

        const containerViewportRatio = containerArea / viewportArea();
        const sizeScore = 2 * (1 - 1/(1 + Math.exp(-10 * (containerViewportRatio - 0.25))));

        let layoutScore = 0;
        if (items.length >= 3) {
            const uniqueRows = new Set(items.map(item => Math.round(item.getBoundingClientRect().top / 5) * 5)).size;
            const uniqueCols = new Set(items.map(item => Math.round(item.getBoundingClientRect().left / 5) * 5)).size;
            if (uniqueRows === 1 || uniqueCols === 1) { layoutScore = 20;
            } else {
                const coverage = Math.min(1, items.length / (uniqueRows * uniqueCols));
                const efficiency = Math.max(0, 1 - (uniqueRows + uniqueCols) / (2 * items.length));
                layoutScore = 20 * (0.7 * coverage + 0.3 * efficiency);
            }
        }

        const totalScore = countScore + areaScore + uniformityScore + layoutScore + sizeScore;
        return totalScore;
    }

    function viewportArea() { return window.innerWidth * window.innerHeight; }

    return findMainList(document.body);
})();`;

// --- Transient text monitor (start_temp_monitor / get_temp_texts) ---

export function monitorStartJs(intervalMs = 450): string {
  return `(function() {
function startStrMonitor(interval) {
        if (window._tm && window._tm.id) clearInterval(window._tm.id);
        window._tm = {extract: () => {
            const texts = new Set(), walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node, t, s; while (node = walker.nextNode())
                ((t = node.textContent.trim()) && t.length > 10 && !(s = t.substring(0, 20)).includes('_')) && texts.add(s);
            return texts;
        }};
        window._tm.init = window._tm.extract();
        window._tm.all = new Set();
        window._tm.id = setInterval(() => window._tm.extract().forEach(t => window._tm.all.add(t)), interval);
    }
    startStrMonitor(${Math.max(50, Math.floor(intervalMs))});
    return true;
})();`;
}

export const MONITOR_STOP_JS = `(function() {
function stopStrMonitor() {
        if (!window._tm) return [];
        clearInterval(window._tm.id);
        const final = window._tm.extract();
        const newlySeen = [...window._tm.all].filter(t => !window._tm.init.has(t));
        let result;
        if (newlySeen.length < 8) {
            result = newlySeen;
        } else {
            result = newlySeen.filter(t => !final.has(t));
        }
        delete window._tm;
        return result;
    }
    return stopStrMonitor();
})();`;

/**
 * foldLists: given an already-simplified HTML string and the lists discovered by
 * findMainList, collapse repetitive list items to the first 3 (or the first 6
 * that mention `instruction`), replacing the rest with a `[FAKE ELEMENT]` hint.
 * Runs in the browser via DOMParser so CSS selectors resolve natively. Ported
 * from simphtml.py get_html(cutlist=True) folding rules.
 *
 * Call as page.evaluate(foldListsJs({ html, lists, instruction })) — the payload
 * is inlined as JSON because puppeteer page.evaluate(string) does not forward
 * arguments to a bare string expression.
 */
export function foldListsJs(payload: { html: string; lists: Array<Record<string, unknown>>; instruction?: string }): string {
  const encoded = JSON.stringify(payload);
  return `(function() {
  const payload = ${encoded};
  const html = payload.html || '';
  const lists = Array.isArray(payload.lists) ? payload.lists : [];
  const instruction = (payload.instruction || '').trim();
  if (!html || lists.length === 0) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let changed = false;
  for (const entry of lists) {
    const sel = entry && entry.selector;
    if (!sel) continue;
    let items;
    try { items = Array.from(doc.querySelectorAll(sel)); }
    catch (e) { continue; }
    if (items.length < 5) continue;
    const total = items.reduce((s, it) => s + it.outerHTML.length, 0);
    const avg = total / items.length;
    if (avg < 200 || (avg < 700 && total < 2500)) continue;
    const hit = instruction
      ? items.filter(it => (it.textContent || '').includes(instruction)).slice(0, 6)
      : [];
    const keep = hit.length > 0 ? hit : items.slice(0, 3);
    const keepSet = new Set(keep);
    const removed = items.filter(it => !keepSet.has(it));
    if (removed.length === 0) continue;
    const samples = removed.slice(0, 5).map(it => (it.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean);
    const hintParts = ['[FAKE ELEMENT] ' + removed.length + ' more items hidden, selector: "' + sel + '"'];
    if (samples.length) hintParts.push('Hidden items: ' + samples.map(t => '"' + t + '"').join(','));
    const hint = doc.createElement('div');
    hint.textContent = hintParts.join(' ');
    if (keep.length > 0) keep[keep.length - 1].after(hint);
    for (const it of removed) it.remove();
    changed = true;
  }
  if (!changed) return html;
  return doc.body ? doc.body.innerHTML : html;
})();`;
}

// --- Host-side post-processing (no DOM dependency) ---

const KEEP_ATTRS = new Set([
  "id", "class", "name", "src", "href", "alt", "value", "type", "placeholder",
  "disabled", "checked", "selected", "readonly", "required", "multiple",
  "role", "aria-label", "aria-expanded", "aria-hidden", "contenteditable",
  "title", "for", "action", "method", "target", "colspan", "rowspan", "data-tag",
]);

const TAG_OPEN = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*?)?)\/?>/g;
const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)'|\s*=\s*([^\s>]+))?/g;
const SELF_TAG = /<(script|style|noscript|svg|colgroup|col|template|param|source|link|meta)\b[^>]*>[\s\S]*?<\/\1>/gi;
const SELF_VOID = /<(script|style|noscript|link|meta)\b[^>]*\/?>/gi;

/**
 * Token optimization: strip script/style/svg, prune attributes to a whitelist,
 * shorten long src/href/value data. String-level port of
 * optimize_html_for_tokens (BeautifulSoup → regex pipeline).
 */
export function optimizeHtmlForTokens(html: string): string {
  let out = html;
  // Remove paired noise containers with their content.
  out = out.replace(SELF_TAG, (_m, tag) => {
    if (tag.toLowerCase() === "svg") return "<svg></svg>";
    return "";
  });
  // Remove remaining void noise tags.
  out = out.replace(SELF_VOID, "");
  // Prune attributes per element.
  out = out.replace(TAG_OPEN, (full, name: string, attrs: string) => {
    if (!attrs) return full;
    const kept: string[] = [];
    let match: RegExpExecArray | null;
    ATTR.lastIndex = 0;
    while ((match = ATTR.exec(attrs)) !== null) {
      const attr = match[1];
      const val = match[2] ?? match[3] ?? match[4] ?? "";
      if (!KEEP_ATTRS.has(attr)) {
        if (attr.startsWith("data-v")) continue;
        if (attr.startsWith("data-") && typeof val === "string" && val.length > 20) continue;
        if (!attr.startsWith("data-")) continue;
      }
      let resolved = val;
      if (attr === "src") {
        if (resolved.startsWith("data:")) resolved = "__img__";
        else if (resolved.length > 30) resolved = "__url__";
      } else if (attr === "href" && resolved.length > 30) {
        resolved = "__link__";
      } else if (attr === "action" && resolved.length > 30) {
        resolved = "__url__";
      } else if (["value", "title", "alt"].includes(attr) && typeof resolved === "string" && resolved.length > 100) {
        resolved = resolved.slice(0, 50) + " ...";
      }
      kept.push(resolved === "" && match[2] === undefined ? attr : `${attr}="${resolved}"`);
    }
    return `<${name}${kept.length ? " " + kept.join(" ") : ""}>`;
  });
  return out;
}

interface TruncChild {
  name: string;
  start: number;
  end: number;
  length: number;
}

const CUT_THRESHOLD = 8000;

/**
 * Recursive truncation toward a character budget: pierce single-child wrappers,
 * proportional share among top-3 children, else tail-cut. String-level port of
 * smart_truncate. Returns the (in-place modified) html string.
 */
export function smartTruncate(html: string, budget: number): string {
  return truncateInPlace(html, budget, 0);
}

function topChildren(html: string): { prefix: string; suffix: string; children: TruncChild[] } | null {
  const open = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  const startMatch = open.exec(html);
  if (!startMatch) return null;
  const tag = startMatch[1];
  const afterOpen = startMatch.index + startMatch[0].length;
  // Find matching close for the root by tag-depth counting.
  const closeRe = new RegExp(`</?${tag}\\b[^>]*>`, "gi");
  closeRe.lastIndex = afterOpen;
  let depth = 1;
  let rootEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = closeRe.exec(html)) !== null) {
    if (m[0].startsWith("</")) {
      depth--;
      if (depth === 0) { rootEnd = m.index; break; }
    } else {
      depth++;
    }
  }
  if (rootEnd === -1) return null;
  const inner = html.slice(afterOpen, rootEnd);
  const children = parseTopChildren(inner);
  return { prefix: html.slice(0, afterOpen), suffix: html.slice(rootEnd), children };
}

function parseTopChildren(inner: string): TruncChild[] {
  const children: TruncChild[] = [];
  let i = 0;
  const text: string[] = [];
  while (i < inner.length) {
    const lt = inner.indexOf("<", i);
    if (lt === -1) { text.push(inner.slice(i)); break; }
    if (lt > i) text.push(inner.slice(i, lt));
    const tagMatch = inner.slice(lt).match(/^<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?\/?>/);
    if (!tagMatch) { text.push(inner.slice(lt, lt + 1)); i = lt + 1; continue; }
    const name = tagMatch[1];
    if (inner[lt + tagMatch[0].length - 2] === "/") {
      children.push({ name, start: lt, end: lt + tagMatch[0].length, length: tagMatch[0].length });
      i = lt + tagMatch[0].length;
      continue;
    }
    const close = findCloseTag(inner, lt, name);
    if (close === -1) { children.push({ name, start: lt, end: inner.length, length: inner.length - lt }); break; }
    children.push({ name, start: lt, end: close, length: close - lt });
    i = close;
  }
  return children;
}

function findCloseTag(html: string, openIndex: number, tag: string): number {
  const openLen = html.slice(openIndex).match(new RegExp(`^<${tag}\\b[^>]*?>`, "i"))?.[0].length;
  if (!openLen) return -1;
  const closeRe = new RegExp(`</?${tag}\\b[^>]*?>`, "gi");
  closeRe.lastIndex = openIndex + openLen;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = closeRe.exec(html)) !== null) {
    if (m[0].startsWith("</")) {
      depth--;
      if (depth === 0) return m.index + m[0].length;
    } else if (m[0].endsWith("/>")) {
      // void self-close within, no depth change
    } else {
      depth++;
    }
  }
  return -1;
}

function truncateInPlace(html: string, budget: number, depth: number): string {
  const total = html.length;
  if (total <= budget) return html;
  const parsed = topChildren(html);
  if (!parsed || parsed.children.length === 0) {
    // Leaf text: hard-cut with marker.
    const over = total - budget;
    const marker = ` [TRUNCATED ${Math.floor(over / 1000)}k chars]`;
    return html.slice(0, Math.max(0, budget - marker.length)) + marker;
  }
  const { prefix, suffix, children } = parsed;
  const kidsLen = children.reduce((sum, c) => sum + c.length, 0);
  const selfLen = total - kidsLen - (prefix.length + suffix.length);
  const remainingBudget = Math.max(budget - selfLen - prefix.length - suffix.length, 0);
  const over = kidsLen - remainingBudget;
  if (over <= 0) return html;

  const ranked = [...children].sort((a, b) => b.length - a.length);
  const topTotal = ranked.slice(0, 3).reduce((s, c) => s + c.length, 0);

  // Reconstruct children spans into the inner string.
  const innerStart = prefix.length;
  const innerEnd = html.length - suffix.length;

  if (topTotal < over) {
    // top-3 cannot cover: tail-cut from end of inner.
    let removed = 0;
    let cutIndex = innerEnd;
    for (let i = children.length - 1; i >= 0 && removed < over; i--) {
      cutIndex = children[i].start + innerStart;
      removed += children[i].length;
    }
    return html.slice(0, cutIndex) + suffix;
  }

  // Proportional share among top filtered children.
  const maxSize = ranked[0].length;
  const filtered = ranked.slice(0, 3).filter((c) => c.length >= maxSize * 0.1);
  const filteredTotal = filtered.reduce((s, c) => s + c.length, 0);
  const sharers = filteredTotal >= over ? filtered : ranked.slice(0, 3);
  const shareTotal = sharers.reduce((s, c) => s + c.length, 0);

  // Rebuild inner by walking original order, truncating sharers.
  let result = "";
  let cursor = innerStart;
  const shareMap = new Map(sharers.map((c) => [c, Math.max(0, c.length - Math.floor((over * c.length) / shareTotal))]));
  for (const child of children) {
    if (child.start + innerStart < cursor) continue;
    result += html.slice(cursor, child.start + innerStart);
    const target = shareMap.get(child);
    const childHtml = html.slice(child.start + innerStart, child.end + innerStart);
    if (target === undefined) {
      result += childHtml;
    } else if (target <= 0) {
      // drop entirely
    } else if (target > CUT_THRESHOLD) {
      result += truncateInPlace(childHtml, target, depth + 1);
    } else {
      const marker = ` [TRUNCATED ${Math.floor((child.length - target) / 1000)}k chars]`;
      result += childHtml.slice(0, Math.max(0, target - marker.length)) + marker;
    }
    cursor = child.end + innerStart;
  }
  result += html.slice(cursor, innerEnd);
  return prefix + result + suffix;
}

export interface HtmlDiff {
  changed: number;
  topChange?: string;
}

interface FlatElement {
  tag: string;
  attrs: Record<string, string>;
  directText: string;
  outer: string;
}

function parseAttrsForSig(attrs: string): Record<string, string> {
  const map: Record<string, string> = {};
  let match: RegExpExecArray | null;
  ATTR.lastIndex = 0;
  while ((match = ATTR.exec(attrs)) !== null) {
    const name = match[1];
    if (name === "data-track-id") continue;
    map[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return map;
}

/** Flatten the HTML into a list of elements with signatures, walking nested
 * children depth-first so every element (not just top-level) is counted. */
function flattenElements(html: string): FlatElement[] {
  const out: FlatElement[] = [];
  // Iterative depth-bounded walk: deep DOMs (e.g. adversarial 5000-level nesting)
  // would overflow the stack under naive recursion, so an explicit stack caps
  // both nesting depth and total elements.
  const MAX_DEPTH = 2000;
  const MAX_ELEMENTS = 50_000;
  const stack: Array<{ slice: string; depth: number }> = [{ slice: html, depth: 0 }];
  while (stack.length > 0 && out.length < MAX_ELEMENTS) {
    const { slice, depth } = stack.pop()!;
    for (const child of parseTopChildren(slice)) {
      const outer = slice.slice(child.start, child.end);
      const openTag = outer.match(/^<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/);
      if (!openTag) continue;
      const tag = openTag[1].toLowerCase();
      const attrs = (openTag[2] ?? "").trim();
      const closeTag = `</${tag}>`;
      const inner = outer.endsWith(closeTag) ? outer.slice(openTag[0].length, outer.length - closeTag.length) : "";
      const directText = inner.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      out.push({ tag, attrs: parseAttrsForSig(attrs), directText, outer });
      if (inner && depth + 1 < MAX_DEPTH) stack.push({ slice: inner, depth: depth + 1 });
    }
  }
  return out;
}

function sigOf(el: FlatElement): string {
  return `${el.tag}:${JSON.stringify(el.attrs)}:${el.directText}`;
}

function buildSigs(html: string): Map<string, FlatElement[]> {
  const result = new Map<string, FlatElement[]>();
  for (const el of flattenElements(html)) {
    const sig = sigOf(el);
    const list = result.get(sig);
    if (list) list.push(el);
    else result.set(sig, [el]);
  }
  return result;
}

/**
 * Diff two HTML strings: count changed elements and surface the largest changed
 * subtree. String-level port of find_changed_elements (BeautifulSoup → recursive walk).
 */
export function diffHtml(before: string, after: string): HtmlDiff {
  const beforeSigs = buildSigs(before);
  const afterSigs = buildSigs(after);
  const changed: string[] = [];
  for (const [sig, els] of afterSigs) {
    const beforeList = beforeSigs.get(sig);
    if (!beforeList) changed.push(...els.map((e) => e.outer));
    else if (els.length > beforeList.length) {
      changed.push(...els.slice(0, els.length - beforeList.length).map((e) => e.outer));
    }
  }
  if (changed.length === 0 && before !== after) {
    // Fallback: first diverging element by position among top-level children.
    const beforeEls = flattenElements(before);
    const afterEls = flattenElements(after);
    const min = Math.min(beforeEls.length, afterEls.length);
    for (let i = 0; i < min; i++) {
      if (sigOf(beforeEls[i]) !== sigOf(afterEls[i])) { changed.push(afterEls[i].outer); break; }
    }
  }
  const top = changed.sort((a, b) => b.length - a.length)[0];
  return {
    changed: changed.length,
    topChange: top ? (top.length <= 2000 ? top : top.slice(0, 2000) + "...[TRUNCATED]") : undefined,
  };
}

/**
 * Verify the browser-side probe scripts parse as valid JS (syntax guard for
 * accidental template-string corruption during porting).
 */
export function validateProbeScripts(): { probe: boolean; lists: boolean; monitorStart: boolean; monitorStop: boolean; fold: boolean } {
  const probe = syntaxOk(PROBE_JS);
  const lists = syntaxOk(FIND_LISTS_JS);
  const monitorStart = syntaxOk(monitorStartJs());
  const monitorStop = syntaxOk(MONITOR_STOP_JS);
  const fold = syntaxOk(foldListsJs({ html: "", lists: [], instruction: "" }));
  return { probe, lists, monitorStart, monitorStop, fold };
}

function syntaxOk(code: string): boolean {
  // The probe scripts are IIFE bodies wrapped for page.evaluate. Validate by
  // constructing an async function; invalid syntax throws at construction.
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => unknown;
    new AsyncFunction(code);
    return true;
  } catch {
    return false;
  }
}
