import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Check, Download, FolderOpen, Gift, Globe, Library, Link, Play, Plus, Search, Trash2 } from 'lucide-react'
import { mangaAdd, mangaAddPeppercarrot, mangaApplyDetails, mangaCreateSeries, mangaImportLinks, mangaRemove, mangaSaveMeta, mangaSearchDetails, mangaSourceCatalog, mangaSourceChapters, mangaStreamLink, openExternal, openPath, pickTransferPaths, type MangaDetails, type MangaSeries, type MangaSourceChapter, type MangaSourceManga } from '../../lib/bridge'
import { usePeriodicRefresh } from '../../core/refresh'
import { useStore } from '../../core/store'
import { Card, SectionTitle } from '../../ui'
import { continueAt, readCount, seriesTitle, sortSeries } from './model'
import { coverUrl, mangaStore, openChapter, refreshManga } from './state'

const PUBLIC_MANGA_SOURCES = [
  { name: 'Asura Scans', url: 'https://asurascans.com/series-ranking' },
  { name: 'Weeb Central', url: 'https://weebcentral.com/' },
  { name: 'MangaKatana', url: 'https://mangakatana.com/' },
]
type CatalogSource = { name: string; url: string }
const CUSTOM_SOURCES_KEY = 'bridgedeck-manga-sources'

export default function MangaPage({ active }: { active: boolean }) {
  const { library, error } = useStore(mangaStore)
  const [open, setOpen] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [name, setName] = useState('')
  const [links, setLinks] = useState('')
  const [linkTitle, setLinkTitle] = useState('')
  const [catalog, setCatalog] = useState<MangaSourceManga[]>([])
  const [catalogSource, setCatalogSource] = useState(PUBLIC_MANGA_SOURCES[0])
  const [catalogPage, setCatalogPage] = useState(1)
  const [catalogQuery, setCatalogQuery] = useState('')
  const [customSources, setCustomSources] = useState<CatalogSource[]>(() => { try { return JSON.parse(localStorage.getItem(CUSTOM_SOURCES_KEY) ?? '[]') } catch { return [] } })
  const [customName, setCustomName] = useState('')
  const [customUrl, setCustomUrl] = useState('')
  usePeriodicRefresh(async () => { if (active) await refreshManga() }, 15_000, [active])
  const list = useMemo(() => sortSeries(library?.series ?? []), [library])
  const current = list.find(s => s.name === open)
  async function loadCatalog(source = catalogSource, page = catalogPage) {
    setStatus(`Loading ${source.name}…`); setCatalog([])
    try { const items = await mangaSourceCatalog(source.url, page, catalogQuery); setCatalog(items); setStatus(`${items.length} manga found on page ${page}.`) } catch (e) { setStatus(String(e)) }
  }
  function saveCustomSource() {
    if (!customName.trim() || !customUrl.trim()) return
    const next = [...customSources, { name: customName.trim(), url: customUrl.trim() }]
    setCustomSources(next); localStorage.setItem(CUSTOM_SOURCES_KEY, JSON.stringify(next)); setCustomName(''); setCustomUrl('')
  }
  async function addCatalogManga(item: MangaSourceManga) {
    try { const series = await mangaCreateSeries(item.title, item.url, item.coverUrl); await refreshManga(); setOpen(series) } catch (e) { setStatus(String(e)) }
  }
  useEffect(() => { void loadCatalog() }, [])

  async function addSeries() {
    if (!name.trim()) return
    const paths = await pickTransferPaths(false)
    if (!paths.length) { setStatus('Choose .cbz or .zip chapters, or the pages of one chapter.'); return }
    try {
      const added = await mangaAdd(name.trim(), paths)
      setStatus(`Added ${added} chapter${added === 1 ? '' : 's'} to ${name.trim()}.`)
      setName('')
      await refreshManga()
    } catch (e) { setStatus(String(e)) }
  }

  async function addPepper() {
    setStatus('Getting Pepper&Carrot episodes 1–5 from the Internet Archive…')
    try {
      const added = await mangaAddPeppercarrot([1, 2, 3, 4, 5])
      setStatus(added ? `Added ${added} Pepper&Carrot episodes (by David Revoy, CC BY 4.0).` : 'Those episodes are already in your library.')
      await refreshManga()
    } catch (e) { setStatus(String(e)) }
  }
  async function addLinks() {
    const items = links.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    if (!name.trim() || !items.length) return
    setStatus('Downloading chapter…')
    try {
      const added = await mangaImportLinks(name.trim(), items, linkTitle)
      setStatus(`Downloaded ${added} chapter${added === 1 ? '' : 's'} to ${name.trim()}.`)
      setLinks(''); setLinkTitle(''); await refreshManga()
    } catch (e) { setStatus(String(e)) }
  }

  if (current) return <SeriesView series={current} onBack={() => setOpen(null)} />
  return <div className="manga">
    <Card><SectionTitle title="Manga" subtitle={library ? `${list.length} series · kept in ${library.root}, on both computers` : 'Your comics, manga and webtoons'}
      action={<div className="actions">{library && <button className="secondary" onClick={() => void openPath(library.root)}><FolderOpen size={15} />Folder</button>}</div>} />
      <form className="study-new" onSubmit={e => { e.preventDefault(); void addSeries() }}>
        <input placeholder="New series name, then choose its .cbz / .zip chapters or page images" value={name} onChange={e => setName(e.target.value)} />
        <button className="ghost" disabled={!name.trim()}><Plus size={14} /> Add</button>
      </form>
      <div className="study-new manga-link-import">
        <input placeholder="Chapter title (optional)" value={linkTitle} onChange={e => setLinkTitle(e.target.value)} />
        <textarea aria-label="Manga chapter links" placeholder="Paste a CBZ/ZIP, reader-page link, or direct image links (one per line)" value={links} onChange={e => setLinks(e.target.value)} />
        <button className="ghost" type="button" disabled={!name.trim() || !links.trim()} onClick={() => void addLinks()}><Link size={14} /> Download links</button>
      </div>
      <div className="manga-source-links" aria-label="Manga catalog sources">
        <span>Catalog:</span>{[...PUBLIC_MANGA_SOURCES, ...customSources].map(source => <button key={source.url} className="ghost" type="button" onClick={() => { setCatalogSource(source); setCatalogPage(1); void loadCatalog(source, 1) }}><Globe size={13} />{source.name}</button>)}
      </div>
      <div className="study-new manga-source-search"><input value={catalogQuery} onChange={e => setCatalogQuery(e.target.value)} placeholder="Search loaded source page" /><button className="secondary" type="button" onClick={() => void loadCatalog(catalogSource, 1)}><Search size={14} />Search</button><button className="ghost" type="button" onClick={() => { const next = catalogPage + 1; setCatalogPage(next); void loadCatalog(catalogSource, next) }}>Next page</button></div>
      <div className="study-new manga-source-search"><input value={customName} onChange={e => setCustomName(e.target.value)} placeholder="Your website name" /><input value={customUrl} onChange={e => setCustomUrl(e.target.value)} placeholder="Its public catalog page" /><button className="ghost" type="button" onClick={saveCustomSource} disabled={!customName.trim() || !customUrl.trim()}><Plus size={14} />Add source</button></div>
      {(status || error) && <p className={error ? 'cal-error' : 'book-status'}>{error || status}</p>}
    </Card>
    {catalog.length > 0 && <><SectionTitle title={catalogSource.name} subtitle="Pick a title — its chapters stay and open inside BridgeDeck" /><div className="manga-grid">{catalog.map(item => <div className="manga-card" key={item.url}><button className="manga-cover" onClick={() => void addCatalogManga(item)}>{item.coverUrl ? <img src={item.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Library size={30} />}</button><strong>{item.title}</strong><button className="ghost manga-continue" onClick={() => void addCatalogManga(item)}><Plus size={13} />Open</button></div>)}</div></>}
    {list.length ? <div className="manga-grid">{list.map(s => {
      const next = continueAt(s)
      const read = readCount(s)
      return <div key={s.name} className="manga-card">
        <button className="manga-cover" onClick={() => setOpen(s.name)} title={seriesTitle(s)}>
          {s.chapters.length ? <img src={coverUrl(s.name, s.modified)} alt="" loading="lazy" /> : <Library size={30} />}
          {s.chapters.length > 0 && <span className="manga-badge">{read}/{s.chapters.length}</span>}
        </button>
        <strong title={seriesTitle(s)}>{seriesTitle(s)}</strong>
        {next && <button className="ghost manga-continue" onClick={() => openChapter(s.name, seriesTitle(s), next.chapter, next.page)}><BookOpen size={13} /> {s.progress.last ? 'Continue' : 'Start'}</button>}
      </div>
    })}</div> : <Card className="study-empty"><Library size={28} /><h3>Start your library</h3>
      <p>Name a series and add its chapters: .cbz or .zip files, or the page images of a chapter. They're kept in the synced folder, so they're on your other computer too, with your place in each.</p>
      <div className="actions"><button className="secondary" onClick={() => void addPepper()}><Gift size={15} />Add Pepper&Carrot (free comic)</button></div>
    </Card>}
  </div>
}

function SeriesView({ series, onBack }: { series: MangaSeries; onBack: () => void }) {
  const title = seriesTitle(series)
  const [query, setQuery] = useState(title)
  const [results, setResults] = useState<MangaDetails[] | null>(null)
  const [status, setStatus] = useState('')
  const [links, setLinks] = useState('')
  const [linkTitle, setLinkTitle] = useState('')
  const [sourceUrl, setSourceUrl] = useState(series.meta.url ?? '')
  const [sourceChapters, setSourceChapters] = useState<MangaSourceChapter[] | null>(null)
  const next = continueAt(series)
  useEffect(() => { setQuery(title) }, [title])

  async function addChapters() {
    const paths = await pickTransferPaths(false)
    if (!paths.length) return
    try { const added = await mangaAdd(series.name, paths); setStatus(`Added ${added} chapter${added === 1 ? '' : 's'}.`); await refreshManga() } catch (e) { setStatus(String(e)) }
  }
  async function addLinks() {
    const items = links.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    if (!items.length) return
    setStatus('Downloading chapter…')
    try {
      const added = await mangaImportLinks(series.name, items, linkTitle)
      setStatus(`Downloaded ${added} chapter${added === 1 ? '' : 's'}.`)
      setLinks(''); setLinkTitle(''); await refreshManga()
    } catch (e) { setStatus(String(e)) }
  }
  async function loadSourceChapters() {
    if (!sourceUrl.trim()) return
    setStatus('Loading public chapter list…'); setSourceChapters(null)
    try { const chapters = await mangaSourceChapters(sourceUrl); setSourceChapters(chapters); await mangaSaveMeta(series.name, { sourceChapterCount: chapters.length }); await refreshManga(); setStatus(`${chapters.length} chapters found and cached.`) } catch (e) { setStatus(String(e)) }
  }
  async function downloadSourceChapter(chapter: MangaSourceChapter) {
    setStatus(`Downloading ${chapter.title}…`)
    try { await mangaImportLinks(series.name, [chapter.url], chapter.title); setStatus(`${chapter.title} downloaded.`); await refreshManga() } catch (e) { setStatus(String(e)) }
  }
  async function streamSourceChapter(chapter: MangaSourceChapter) {
    setStatus(`Opening ${chapter.title}…`)
    try {
      const opened = await mangaStreamLink(series.name, chapter.url, chapter.title)
      await refreshManga()
      openChapter(series.name, title, opened.id, 0)
    } catch (e) { setStatus(String(e)) }
  }
  useEffect(() => {
    if (sourceUrl.trim()) void loadSourceChapters()
    // A catalog title should feel complete on open: fetch its chapters in the Manga tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.name])
  async function search() {
    try { setResults(await mangaSearchDetails(query)); setStatus('') } catch (e) { setStatus(String(e)) }
  }
  async function apply(details: MangaDetails) {
    try { await mangaApplyDetails(series.name, details); setResults(null); setStatus('Details and cover saved.'); await refreshManga() } catch (e) { setStatus(String(e)) }
  }
  async function remove(chapter?: string) {
    if (!window.confirm(chapter ? `Remove this chapter? It's removed from your other computer too.` : `Remove ${title} and all its chapters? It's removed from your other computer too.`)) return
    try { await mangaRemove(series.name, chapter); if (!chapter) onBack(); await refreshManga() } catch (e) { setStatus(String(e)) }
  }

  const meta = series.meta
  return <div className="manga">
    <Card>
      <div className="manga-hero">
        <div className="manga-hero-cover">{series.chapters.length ? <img src={coverUrl(series.name, series.modified)} alt="" /> : <Library size={30} />}</div>
        <div className="grow">
          <button className="ghost" onClick={onBack}>← Library</button>
          <h2>{title}</h2>
          <p className="manga-sub">{[meta.author, meta.year, meta.status, meta.format, meta.sourceChapterCount && `${meta.sourceChapterCount} source chapters`].filter(Boolean).join(' · ')}</p>
          {!!meta.genres?.length && <div className="manga-genres">{meta.genres.map(g => <span key={g}>{g}</span>)}</div>}
          {meta.description && <p className="manga-desc">{meta.description}</p>}
          {meta.attribution && <p className="hint">By <a href={meta.attribution.url} onClick={e => { e.preventDefault(); void openExternal(meta.attribution!.url) }}>{meta.attribution.author}</a>, {meta.attribution.license}.</p>}
          <div className="actions">
            {next && <button onClick={() => openChapter(series.name, title, next.chapter, next.page)}><BookOpen size={15} />{series.progress.last ? 'Continue' : 'Start reading'}</button>}
            <button className="secondary" onClick={() => void addChapters()}><Plus size={15} />Add chapters</button>
            <button className="secondary" onClick={() => void remove()}><Trash2 size={15} />Remove</button>
          </div>
          {status && <p className="book-status">{status}</p>}
        </div>
      </div>
    </Card>
    <Card className="manga-link-import-card">
      <SectionTitle title="Read from a source" subtitle="Choose a chapter to stream inside BridgeDeck, or download it fully for offline use." />
      <div className="study-new manga-link-import">
        <input placeholder="Chapter title (optional)" value={linkTitle} onChange={e => setLinkTitle(e.target.value)} />
        <textarea aria-label="Manga chapter links" placeholder="https://example.com/chapter or direct image links" value={links} onChange={e => setLinks(e.target.value)} />
        <button type="button" onClick={() => void addLinks()} disabled={!links.trim()}><Link size={14} /> Download chapter</button>
      </div>
      <div className="study-new manga-link-import">
        <input aria-label="Source series page" placeholder="Paste an Asura, Weeb Central, or MangaKatana series page" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} />
        <button className="secondary" type="button" onClick={() => void loadSourceChapters()} disabled={!sourceUrl.trim()}><Search size={14} /> Find chapters</button>
      </div>
      {sourceChapters && <div className="manga-source-chapters">{sourceChapters.slice(0, 200).map(chapter => <div key={chapter.url}><span>{chapter.title}</span><button type="button" className="ghost" onClick={() => void streamSourceChapter(chapter)}><Play size={14} />Stream</button><button type="button" className="ghost" onClick={() => void downloadSourceChapter(chapter)}><Download size={14} />Download</button></div>)}</div>}
    </Card>
    <div className="two-col">
      <Card><SectionTitle title="Chapters" subtitle={`${readCount(series)} of ${series.chapters.length} read`} />
        <div className="manga-chapters">{series.chapters.map(c => {
          const state = series.progress.chapters?.[c.id]
          const marks = series.progress.bookmarks?.[c.id]?.length ?? 0
          return <div key={c.id} className={`manga-chapter${state?.done ? ' done' : ''}`}>
            <button className="grow" onClick={() => openChapter(series.name, title, c.id, state && !state.done ? state.page : 0)}>
              {state?.done ? <Check size={13} /> : <BookOpen size={13} />}<span>{c.title}</span>
              {state && !state.done && <small>p. {state.page + 1}/{state.pages}</small>}{marks > 0 && <small>{marks} bookmark{marks === 1 ? '' : 's'}</small>}
            </button>
            <button className="cal-icon" title="Remove chapter" onClick={() => void remove(c.id)}><Trash2 size={13} /></button>
          </div>
        })}</div>
      </Card>
      <Card><SectionTitle title="Details" subtitle="Look up the title, description, genres and cover on AniList" />
        <form className="study-new" onSubmit={e => { e.preventDefault(); void search() }}>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Title" />
          <button className="cal-icon" title="Search AniList" disabled={!query.trim()}><Search size={15} /></button>
        </form>
        {results && (results.length ? <div className="manga-results">{results.map(r => <button key={r.anilistId} onClick={() => void apply(r)}>
          {r.cover && <img src={r.cover} alt="" referrerPolicy="no-referrer" />}
          <span className="grow"><strong>{r.title}</strong><small>{[r.author, r.year, r.format].filter(Boolean).join(' · ')}</small></span>
        </button>)}</div> : <p className="hint">Nothing found on AniList.</p>)}
      </Card>
    </div>
  </div>
}
