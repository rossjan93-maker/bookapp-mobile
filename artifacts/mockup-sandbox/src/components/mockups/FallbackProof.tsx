import { useState } from 'react';

const DUST   = '#9e958d';
const STONE  = '#6b635c';
const BORDER = '#ede9e4';
const SAGE   = '#7b9e7e';
const BG     = '#f5f1ec';
const CARD   = '#fefcf9';
const INK    = '#231f1b';

function titleInitials(title: string): string {
  const STOP_WORDS = new Set(['a', 'an', 'the']);
  const words = title.trim().split(/\s+/).filter(w => w.length > 0);
  const meaningful = words.filter(w => !STOP_WORDS.has(w.toLowerCase()));
  const source = meaningful.length > 0 ? meaningful : words;
  return source.slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('');
}

function CoverThumbFallback({
  title,
  width = 44,
  height = 64,
  radius = 5,
}: {
  title: string;
  width?: number;
  height?: number;
  radius?: number;
}) {
  const isLarge    = width >= 56;
  const initials   = titleInitials(title);
  const letterSize = isLarge ? Math.round(width * 0.36) : Math.round(width * 0.42);

  return (
    <div style={{
      width, height,
      borderRadius: radius,
      backgroundColor: BG,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{ height: 3, backgroundColor: SAGE, flexShrink: 0 }} />
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 4px',
      }}>
        <span style={{
          fontSize: letterSize,
          fontWeight: 700,
          color: STONE,
          letterSpacing: isLarge ? 2 : 0.5,
          lineHeight: 1.1,
          fontFamily: 'Georgia, serif',
        }}>
          {initials}
        </span>
        {isLarge && (
          <span style={{
            fontSize: 7,
            fontWeight: 600,
            color: DUST,
            letterSpacing: 1.2,
            textTransform: 'uppercase',
            marginTop: 5,
            fontFamily: 'system-ui, sans-serif',
          }}>
            No cover
          </span>
        )}
      </div>
    </div>
  );
}

function RealCoverThumb({
  url,
  title,
  width = 44,
  height = 64,
  radius = 5,
}: {
  url: string;
  title: string;
  width?: number;
  height?: number;
  radius?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <CoverThumbFallback title={title} width={width} height={height} radius={radius} />;
  return (
    <div style={{
      width, height,
      borderRadius: radius,
      backgroundColor: BORDER,
      overflow: 'hidden',
      position: 'relative',
    }}>
      <img
        src={url}
        alt={title}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function LibraryCard({
  title,
  author,
  status,
  coverUrl,
}: {
  title: string;
  author: string;
  status: string;
  coverUrl?: string;
}) {
  const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
    'Want to Read': { bg: '#f1f5f9', text: '#475569' },
    'Reading':      { bg: '#dbeafe', text: '#1d4ed8' },
    'Finished':     { bg: '#dcfce7', text: '#15803d' },
  };
  const badge = STATUS_COLORS[status] ?? STATUS_COLORS['Want to Read'];

  return (
    <div style={{
      backgroundColor: CARD,
      borderRadius: 12,
      padding: '14px 16px',
      display: 'flex',
      alignItems: 'flex-start',
      gap: 14,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: BORDER,
      marginBottom: 10,
    }}>
      {coverUrl ? (
        <RealCoverThumb url={coverUrl} title={title} width={48} height={70} />
      ) : (
        <CoverThumbFallback title={title} width={48} height={70} />
      )}
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 16, color: INK, marginBottom: 3, lineHeight: '22px' }}>
          {title}
        </div>
        <div style={{ color: '#78716c', fontSize: 13, marginBottom: 8 }}>{author}</div>
        <span style={{
          backgroundColor: badge.bg,
          color: badge.text,
          fontSize: 11,
          fontWeight: 600,
          padding: '3px 8px',
          borderRadius: 6,
        }}>
          {status}
        </span>
      </div>
    </div>
  );
}

function NoSummaryCard() {
  return (
    <div style={{
      backgroundColor: CARD,
      borderRadius: 14,
      padding: 18,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: BORDER,
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: DUST,
        letterSpacing: 0.9,
        textTransform: 'uppercase',
        marginBottom: 10,
        fontFamily: 'system-ui, sans-serif',
      }}>
        About
      </div>
      <div style={{
        fontSize: 14,
        fontStyle: 'italic',
        color: DUST,
        lineHeight: '22px',
        fontFamily: 'Georgia, serif',
      }}>
        No summary available for this edition.
      </div>
    </div>
  );
}

function RealSummaryCard({ text }: { text: string }) {
  return (
    <div style={{
      backgroundColor: CARD,
      borderRadius: 14,
      padding: 18,
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: BORDER,
    }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: DUST,
        letterSpacing: 0.9,
        textTransform: 'uppercase',
        marginBottom: 10,
        fontFamily: 'system-ui, sans-serif',
      }}>
        About
      </div>
      <div style={{
        fontSize: 14,
        color: '#57534e',
        lineHeight: '24px',
        fontFamily: 'Georgia, serif',
      }}>
        {text}
      </div>
    </div>
  );
}

export function FallbackProof() {
  return (
    <div style={{
      backgroundColor: BG,
      minHeight: '100vh',
      padding: '24px 20px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <div style={{ maxWidth: 420, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <div style={{
            fontSize: 10, fontWeight: 700, color: SAGE,
            letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 4,
          }}>
            Runtime proof
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: INK }}>
            Fallback UI States
          </div>
        </div>

        {/* Section 1: Cover fallback — library cards */}
        <div style={{ marginBottom: 8, fontSize: 11, fontWeight: 700, color: DUST, letterSpacing: 0.8, textTransform: 'uppercase' }}>
          Cover fallback — library card (48×70)
        </div>

        {/* Book with a real, trusted Google Books cover */}
        <div style={{ marginBottom: 6, fontSize: 11, color: SAGE, fontWeight: 600 }}>
          ✓ Trusted GB cover renders normally
        </div>
        <LibraryCard
          title="Before We Were Strangers"
          author="Renée Carlino"
          status="Finished"
          coverUrl="https://books.google.com/books/content?id=FMAvBgAAQBAJ&printsec=frontcover&img=1&zoom=1&source=gbs_api"
        />

        {/* Book with null cover → typographic fallback */}
        <div style={{ marginBottom: 6, fontSize: 11, color: '#c4b5a5', fontWeight: 600 }}>
          ✗ No cover → typographic fallback (initials + SAGE strip)
        </div>
        <LibraryCard
          title="The Night Circus"
          author="Erin Morgenstern"
          status="Want to Read"
        />

        {/* Book with untrusted URL → treated as no-cover */}
        <div style={{ marginBottom: 6, fontSize: 11, color: '#c4b5a5', fontWeight: 600 }}>
          ✗ Untrusted URL (randomcdn.io) → credibility guard rejects → fallback
        </div>
        <LibraryCard
          title="Dune"
          author="Frank Herbert"
          status="Reading"
          coverUrl="https://randomcdn.io/dune-cover.jpg"
        />

        {/* Book with broken URL → onError triggers fallback */}
        <div style={{ marginBottom: 6, fontSize: 11, color: '#c4b5a5', fontWeight: 600 }}>
          ✗ Valid-looking URL, 404 on load → onError → fallback
        </div>
        <LibraryCard
          title="A Little Life"
          author="Hanya Yanagihara"
          status="Finished"
          coverUrl="https://covers.openlibrary.org/b/id/9999999999-L.jpg"
        />

        {/* Section 2: Large cover fallback (featured card size 72×106) */}
        <div style={{ marginBottom: 8, marginTop: 24, fontSize: 11, fontWeight: 700, color: DUST, letterSpacing: 0.8, textTransform: 'uppercase' }}>
          Cover fallback — featured/detail size (72×106)
        </div>
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 10, color: SAGE, marginBottom: 6, fontWeight: 600 }}>✓ With cover</div>
            <RealCoverThumb
              url="https://books.google.com/books/content?id=QkGNEAAAQBAJ&printsec=frontcover&img=1&zoom=1"
              title="A Little Life"
              width={72}
              height={106}
              radius={7}
            />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#c4b5a5', marginBottom: 6, fontWeight: 600 }}>✗ No cover</div>
            <CoverThumbFallback title="The Night Circus" width={72} height={106} radius={7} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#c4b5a5', marginBottom: 6, fontWeight: 600 }}>✗ Single word</div>
            <CoverThumbFallback title="Dune" width={72} height={106} radius={7} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: '#c4b5a5', marginBottom: 6, fontWeight: 600 }}>✗ Article skip</div>
            <CoverThumbFallback title="The Midnight Library" width={72} height={106} radius={7} />
          </div>
        </div>

        {/* Section 3: Description fallback */}
        <div style={{ marginBottom: 8, fontSize: 11, fontWeight: 700, color: DUST, letterSpacing: 0.8, textTransform: 'uppercase' }}>
          Description — no summary vs. real summary
        </div>
        <div style={{ marginBottom: 6, fontSize: 11, color: SAGE, fontWeight: 600 }}>
          ✓ Real description renders normally
        </div>
        <div style={{ marginBottom: 12 }}>
          <RealSummaryCard text="Two strangers meet on a train, and the only thing Rosie knows about the gorgeous blue-eyed man is his name: Matt. But sometimes an instant connection is all you need to change your life…" />
        </div>
        <div style={{ marginBottom: 6, fontSize: 11, color: '#c4b5a5', fontWeight: 600 }}>
          ✗ No description → premium no-summary fallback
        </div>
        <NoSummaryCard />

      </div>
    </div>
  );
}
