<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import type { Doc } from '../../core/model/types';
  import { parse } from '../commands/grammar';
  import { suggest, type Suggestion } from '../../core/commands/suggest';
  import { dispatchText } from '../commands/dispatch';
  import { recentIds, touchUnit } from '../commands/recent.svelte';
  import { selection } from '../model/store.svelte';
  import { tokenize } from '../../core/commands/tokenize';
  import { miniSymbol } from './mini';
  import { barRequest, lastResult, assessPrompt, write, ui, env, type Theme } from './shell.svelte';

  let { doc, theme }: { doc: Doc; theme: Theme } = $props();

  const HISTORY_KEY = 'opsmap.ui.history';
  let input: HTMLInputElement;
  let value = $state('');
  let cursor = $state(0);
  let focused = $state(false);
  let open = $state(false);
  let active = $state(0);
  let navigated = $state(false);
  let scrollLeft = $state(0);
  let history: string[] = (() => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); } catch { return []; } })();
  let historyAt = -1;
  let draft = '';

  const isCommand = $derived(value.trimStart().startsWith('/'));
  const result = $derived(isCommand && value.trim().length > 1 ? parse(value, doc) : null);
  const sug = $derived(isCommand && focused ? suggest(value, cursor, doc, { recent: recentIds(doc) }) : { items: [] as Suggestion[], ghost: '' });
  const items = $derived(sug.items);
  const showPop = $derived(open && focused && items.length > 0);

  // Selecting a unit on the map counts as using it: it leads the next unit list.
  // untrack: touchUnit reads the list it writes, which would re-run this effect without end.
  $effect(() => { const id = selection.selectedId; if (id) untrack(() => touchUnit({ id })); });

  /** Remaining syntax slots after the complete tokens typed so far (inline ghost). */
  const ghostTail = $derived.by(() => {
    if (!isCommand || cursor !== value.length || !/\s$/.test(value) || !sug.ghost || sug.ghost.includes(' | ')) return '';
    let typed = 0;
    try { typed = tokenize(value).length - 1; } catch { return ''; }
    const slots = sug.ghost.match(/\[[^\]]*\]|"[^"]*"|\S+/g) ?? [];
    return slots.slice(typed).join(' ');
  });

  /** Error at the end of the input = the order is not finished yet, not wrong. */
  const completing = $derived(Boolean(result && !result.ok && focused && !/\s$/.test(value) && cursor === value.length && sug.items.length && result.at <= cursor));
  const incomplete = $derived(Boolean(result && !result.ok && result.at >= value.trimEnd().length) || completing);
  /** The bad token, for the error underline. */
  const underline = $derived.by(() => {
    if (!result || result.ok || incomplete) return null;
    const at = Math.max(0, Math.min(result.at, value.length));
    let end = at;
    while (end < value.length && !/\s/.test(value[end])) end++;
    return { before: value.slice(0, at), bad: value.slice(at, Math.max(end, at + 1)) || ' ' };
  });

  // Result line: shows the last executed order until the user starts typing again.
  let shownResult = $state<{ text: string; ok: boolean } | null>(null);
  let lastSeq = 0;
  $effect(() => {
    if (lastResult.seq !== lastSeq) { lastSeq = lastResult.seq; shownResult = { text: lastResult.text, ok: lastResult.ok }; }
  });

  let barSeq = 0;
  $effect(() => {
    if (barRequest.seq !== barSeq) {
      barSeq = barRequest.seq;
      const text = barRequest.text, caret = barRequest.caret ?? text.length;
      value = text; open = true; active = 0; navigated = false;
      tick().then(() => { input?.focus(); input?.setSelectionRange(caret, caret); cursor = caret; });
    }
  });

  $effect(() => {
    if (showPop) { const i = active; tick().then(() => document.getElementById(`cmd-option-${i}`)?.scrollIntoView({ block: 'nearest' })); }
  });

  function sync() { cursor = input.selectionStart ?? value.length; scrollLeft = input.scrollLeft; }

  function accept(s: Suggestion) {
    const before = value.slice(0, cursor);
    let start = cursor;
    if (!/\s$/.test(before) && before.length) {
      try { start = tokenize(before).at(-1)?.start ?? cursor; } catch { start = before.lastIndexOf(' ') + 1; }
    }
    const insert = (s.kind === 'verb' ? `/${s.insert}` : s.insert) + ' ';
    value = value.slice(0, start) + insert + value.slice(cursor).replace(/^\S*\s?/, '');
    const caret = start + insert.length;
    active = 0; navigated = false; open = true;
    tick().then(() => { input.setSelectionRange(caret, caret); sync(); });
  }

  function execute() {
    const text = value.trim();
    if (!text) return;
    const res = dispatchText(text);
    if (res.ok) {
      history = [text, ...history.filter(h => h !== text)].slice(0, 50);
      write(HISTORY_KEY, JSON.stringify(history));
      historyAt = -1;
      value = ''; cursor = 0; open = false;
      lastResult.text = res.log; lastResult.ok = !res.log.includes('already ran') && !res.log.includes('after 0400'); lastResult.seq++;
      assessPrompt(res.log);
    } else {
      open = false;
      shownResult = { text: res.error, ok: false };
      if (res.at !== undefined) { const at = res.at; tick().then(() => { input.setSelectionRange(at, at); sync(); }); }
    }
  }

  function recall(step: number) {
    if (!history.length) return;
    if (historyAt === -1) draft = value;
    historyAt = Math.max(-1, Math.min(history.length - 1, historyAt + step));
    value = historyAt === -1 ? draft : history[historyAt];
    open = false;
    tick().then(() => { input.setSelectionRange(value.length, value.length); sync(); });
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Tab') {
      if (showPop) { e.preventDefault(); accept(items[active]); }
      else if (isCommand) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      if (showPop) { e.preventDefault(); active = Math.min(active + 1, items.length - 1); navigated = true; }
      else if (historyAt >= 0) { e.preventDefault(); recall(-1); }
      return;
    }
    if (e.key === 'ArrowUp') {
      if (showPop && (navigated || value.trim() !== '' ) && historyAt === -1) { e.preventDefault(); active = Math.max(active - 1, 0); navigated = true; }
      else if (value === '' || historyAt >= 0) { e.preventDefault(); recall(1); }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (showPop) open = false;
      else if (value) { value = ''; historyAt = -1; }
      else input.blur();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (showPop && navigated) accept(items[active]);
      else execute();
    }
  }
  function oninput() {
    open = true; active = 0; navigated = false; historyAt = -1; shownResult = null;
    sync();
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]'))) return;
      e.preventDefault();
      if (!value) value = '/';
      open = true;
      tick().then(() => { input.focus(); input.setSelectionRange(value.length, value.length); sync(); });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const KIND: Record<Suggestion['kind'], string> = { verb: 'CMD', unit: 'UNIT', sector: 'AO', echelon: 'SIZE', function: 'FN', identity: 'ID', keyword: 'KW', date: 'DATE' };
  const unitOf = (id?: string) => (id ? doc.units.find(u => u.id === id) : undefined);
</script>

<div class="cmd" data-testid="command-bar">
  {#if showPop}
    <ul class="pop" role="listbox" id="cmd-pop" aria-label="Suggestions">
      {#each items as s, i (s.kind + s.insert + (s.unitId ?? '') + i)}
        {@const u = unitOf(s.unitId)}
        <li id="cmd-option-{i}" role="option" aria-selected={i === active} class:active={i === active}
          onpointerdown={(e) => { e.preventDefault(); accept(s); }} onpointerenter={() => (active = i)}>
          <span class="glyph">
            {#if u}
              {@const sym = miniSymbol(u, theme, 13)}
              <img src={sym.href} alt="" width={Math.min(sym.width, 40)} height={Math.min(sym.height, 22)} />
            {:else}
              <span class="kind">{KIND[s.kind]}</span>
            {/if}
          </span>
          <span class="label">{s.label}</span>
          {#if s.detail}<span class="detail">{s.detail}</span>{/if}
        </li>
      {/each}
      <li class="keys" aria-hidden="true" class:hide={env.tier === 'phone' || env.coarse}><b>Tab</b> accept · <b>↑↓</b> choose · <b>Enter</b> run · <b>Esc</b> close</li>
    </ul>
  {/if}

  <div class="line" class:err={result && !result.ok && !incomplete}>
    <span class="prompt" aria-hidden="true">›</span>
    <div class="wrap">
      <div class="mirror" aria-hidden="true" style="transform: translateX({-scrollLeft}px)">
        {#if underline}<span class="ghost-text">{underline.before}</span><span class="bad">{underline.bad}</span>{:else}<span class="ghost-text">{value}</span>{#if ghostTail}<span class="ghost">{ghostTail}</span>{/if}{/if}
      </div>
      <input bind:this={input} bind:value class="input" type="text" spellcheck="false" autocomplete="off"
        autocapitalize="off" autocorrect="off" enterkeyhint="send"
        placeholder={env.coarse || env.tier === 'phone' ? 'Order: /new, /attack, /bda, /help' : 'Press / to give an order: /new, /attack, /bda, /help'}
        aria-label="Command" role="combobox" aria-expanded={showPop} aria-controls="cmd-pop" aria-autocomplete="list" aria-activedescendant={showPop ? `cmd-option-${active}` : undefined}
        aria-invalid={result ? !result.ok && !incomplete : undefined} data-testid="command-input"
        {onkeydown} {oninput} onkeyup={sync} onclick={sync} onscroll={sync}
        onfocus={() => { focused = true; ui.barFocused = true; open = true; sync(); }} onblur={() => { focused = false; ui.barFocused = false; }} />
    </div>
    {#if env.tier === 'phone' || env.coarse}
      <!-- Keeps the keyboard up: pointerdown must not move focus off the input. -->
      <button class="send" type="button" aria-label="Send order" data-testid="command-send" disabled={!value.trim()}
        onpointerdown={(e) => e.preventDefault()} onclick={() => { if (showPop && navigated) accept(items[active]); else execute(); }}>Send</button>
    {:else}
      <span class="key" aria-hidden="true">{focused ? 'ENTER' : '/'}</span>
    {/if}
  </div>

  <div class="preview" aria-live="polite" data-testid="command-preview">
    {#if result?.ok}
      <span class="pv-ok">▸ {result.preview}{sug.ghost.startsWith('sec read') ? ` · ${sug.ghost}` : ''}</span>
    {:else if result && !result.ok && incomplete}
      <span class="pv-hint">… {completing ? `${sug.items[0].label} — ${sug.items[0].detail ?? 'Tab to complete'}` : result.error.replace(/^Expected /, 'Next: ')}{sug.ghost ? ` · ${sug.ghost}` : ''}</span>
    {:else if result && !result.ok}
      <span class="pv-err">✕ {result.error}</span>
    {:else if shownResult}
      <span class={shownResult.text.includes('already ran') || shownResult.text.includes('after 0400') ? 'pv-hint' : shownResult.ok ? 'pv-done' : 'pv-err'}>{shownResult.text.includes('already ran') || shownResult.text.includes('after 0400') ? '…' : shownResult.ok ? '✓' : '✕'} {shownResult.text}</span>
    {:else if isCommand && sug.ghost}
      <span class="pv-hint">{sug.ghost}</span>
    {:else}
      <span class="pv-hint">Orders run only when they resolve. Tab completes, ↑ recalls history.</span>
    {/if}
  </div>
</div>

<style>
  .cmd { position: relative; width: 100%; }
  .line {
    display: flex; align-items: center; gap: var(--s2); height: 36px; padding: 0 var(--s2);
    background: var(--panel); border: 2px solid var(--rule-strong); box-shadow: var(--shadow);
  }
  .line:focus-within { border-color: var(--accent); }
  .line.err:focus-within { border-color: var(--hostile); }
  .prompt { font: 700 16px/1 var(--font-mono); color: var(--accent); }
  .wrap { position: relative; flex: 1; height: 100%; overflow: hidden; }
  .input, .mirror { font: 500 13px/34px var(--font-mono); letter-spacing: 0; white-space: pre; }
  .input { position: relative; z-index: 1; width: 100%; height: 100%; padding: 0; border: 0; outline: none; background: transparent; }
  .input::placeholder { color: var(--ink-3); }
  .mirror { position: absolute; left: 0; top: 0; pointer-events: none; color: transparent; }
  .ghost { color: var(--ink-3); opacity: 0.8; }
  .ghost-text { color: transparent; }
  .bad { color: transparent; text-decoration: underline wavy var(--hostile); text-decoration-thickness: 1.5px; text-underline-offset: 4px; }
  .key { font: 600 12px/1 var(--font-cond); letter-spacing: 0.12em; padding: 3px 5px; border: 1px solid var(--rule); color: var(--ink-3); }
  .preview { height: 22px; padding: 4px var(--s2) 0; font: 500 12px/1.4 var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: var(--panel-glass); border: 1px solid var(--rule); border-top: 0; }
  .preview > span { display: block; overflow: hidden; text-overflow: ellipsis; }
  .pv-ok { color: var(--friend); font-weight: 600; letter-spacing: 0.02em; }
  .pv-done { color: var(--ok); }
  .pv-err { color: var(--hostile); }
  .pv-hint { color: var(--ink-3); }
  .pop {
    position: absolute; left: 0; right: 0; bottom: calc(100% + 4px); margin: 0; padding: 0; list-style: none; z-index: 5;
    background: var(--panel); border: 1px solid var(--rule-strong); box-shadow: var(--shadow); max-height: min(320px, var(--pop-max, 320px)); overflow: auto; overscroll-behavior: contain; touch-action: pan-y;
  }
  .pop li { display: grid; grid-template-columns: 44px minmax(90px, auto) 1fr; align-items: center; gap: var(--s2); padding: 3px var(--s2); cursor: pointer; min-height: 26px; }
  .pop li.active { background: var(--accent-bg); box-shadow: inset 3px 0 0 var(--accent); }
  .glyph { display: flex; align-items: center; justify-content: center; height: 22px; }
  .glyph img { object-fit: contain; }
  .kind { font: 700 12px/1 var(--font-cond); letter-spacing: 0.1em; color: var(--ink-3); border: 1px solid var(--rule); padding: 2px 3px; }
  .label { font: 600 12px/1 var(--font-mono); }
  .detail { color: var(--ink-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pop li.keys { display: block; cursor: default; border-top: 1px solid var(--rule); color: var(--ink-3); font-size: 12px; padding: 4px var(--s2); }
  .keys b { color: var(--ink-2); }
  .keys.hide { display: none !important; }
  .send { flex: none; min-width: 56px; height: 44px; margin-right: -8px; border: 0; border-left: 1px solid var(--rule); background: none; color: var(--accent); font: 700 13px/1 var(--font-cond); letter-spacing: 0.12em; text-transform: uppercase; touch-action: pan-x pan-y; }
  .send:disabled { color: var(--ink-3); opacity: 0.6; }
  /* Phone: 44 px rows, 16 px input text (iOS zooms the page on focus below 16 px). */
  :global([data-tier='phone']) .line { height: 48px; }
  :global([data-tier='phone']) .input, :global([data-tier='phone']) .mirror { font-size: 16px; line-height: 44px; }
  :global([data-tier='phone']) .pop li { min-height: 44px; grid-template-columns: 44px minmax(72px, auto) 1fr; }
  :global([data-tier='phone']) .preview { height: 24px; }
  /* Landscape phone: every pixel of height goes to the map. */
  @media (max-height: 500px) { :global([data-tier='phone']) .preview { display: none; } :global([data-tier='phone']) .line { height: 44px; } }
  @media (pointer: coarse) { .input, .mirror { font-size: 16px; } }
  .cmd { touch-action: pan-x pan-y; }
</style>
