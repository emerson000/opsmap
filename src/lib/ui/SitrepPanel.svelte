<script lang="ts">
  import type { Doc } from '../../core/model/types';
  import { sitrepText } from '../../core/commands/sitrep';
  import { localDay } from '../../core/commands/tokenize';
  import { ui, env, run, toast } from './shell.svelte';
  import { copyText } from './files';

  let { doc, now }: { doc: Doc; now: Date } = $props();
  // `now` ticks every 15 s and log times come from the server, so an op made since the last tick would
  // fall after `now` and be left out ("No changes recorded"). Report as of the latest of the three.
  const asOf = $derived(new Date(Math.max(now.getTime(), Date.now(), ...doc.log.slice(-1).map(e => Date.parse(e.at)).filter(Number.isFinite))));
  const text = $derived(sitrepText(doc, asOf));
  const todayIntent = $derived(doc.intent?.date === localDay(now,doc.settings.tz) ? doc.intent.text : '');
  let intent = $state('');
  let input = $state<HTMLInputElement>();
  $effect(() => { intent = todayIntent; });
  // No autofocus on touch screens: it would raise the keyboard over the report.
  $effect(() => { if (!todayIntent && !env.coarse && env.tier !== 'phone') input?.focus(); });

  function save(e: SubmitEvent) {
    e.preventDefault();
    if (intent.trim() && intent.trim() !== todayIntent) run({ verb: 'intent', args: { text: intent.trim() } });
  }
  async function copy() { toast((await copyText(text)) ? 'SITREP copied' : 'Copy failed: select the text and copy it', 'info'); }
</script>

<div class="sitrep" role="dialog" aria-modal="false" aria-labelledby="sitrep-title" data-testid="sitrep"
  tabindex="-1" onkeydown={(e) => { if (e.key === 'Escape') ui.sitrepOpen = false; }}>
  <header>
    <span id="sitrep-title" class="cap">Morning SITREP</span>
    <button class="btn" onclick={copy}>Copy</button>
    <button class="btn" onclick={() => (ui.sitrepOpen = false)} aria-label="Close SITREP">Close</button>
  </header>
  <pre>{text}</pre>
  <form onsubmit={save}>
    <label for="intent" class="cap">Intent</label>
    <div class="row">
      <input id="intent" class="field" bind:this={input} bind:value={intent} placeholder="One sentence: what must be true by tonight?" maxlength="200" />
      <button class="btn" type="submit" disabled={!intent.trim() || intent.trim() === todayIntent}>Set</button>
    </div>
  </form>
</div>

<style>
  .sitrep { width: min(640px, 100%); max-height: 100%; display: flex; flex-direction: column; background: var(--panel); border: 2px solid var(--rule-strong); box-shadow: var(--shadow); }
  header { display: flex; align-items: center; gap: var(--s1); padding: var(--s2) var(--s3); border-bottom: 1px solid var(--rule); background: var(--panel-2); }
  header .cap { flex: 1; color: var(--ink); }
  pre { margin: 0; padding: var(--s3); font: 12px/1.6 var(--font-mono); white-space: pre-wrap; max-height: 46vh; overflow: auto; overscroll-behavior: contain; touch-action: pan-y; }
  :global([data-tier='phone']) .sitrep pre { flex: 1 1 auto; min-height: 0; max-height: none; font-size: 13px; }
  :global([data-tier='phone']) .sitrep .btn { height: 44px; padding: 0 var(--s3); }
  :global([data-tier='phone']) .row .field { height: 44px; }
  form { padding: var(--s2) var(--s3) var(--s3); border-top: 1px dashed var(--rule); }
  .row { display: flex; gap: var(--s1); margin-top: var(--s1); }
  .row .field { height: 28px; }
</style>
