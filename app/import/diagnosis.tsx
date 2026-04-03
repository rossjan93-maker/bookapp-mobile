import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { BackButton } from '../../components/BackButton';
import { supabase } from '../../lib/supabase';
import {
  computeTasteProfile,
  generateHypotheses,
  DIAGNOSIS_QUESTIONS,
  CONFIDENCE_LABELS,
} from '../../lib/tasteProfile';
import type { TasteHypothesis, DiagnosisQuestion, TasteProfile } from '../../lib/tasteProfile';

// ── Types ─────────────────────────────────────────────────────────────────────

type Step = 'loading' | 'hypotheses' | 'questions' | 'done';

// ── Helpers ───────────────────────────────────────────────────────────────────

function ProgressDots({ total, current }: { total: number; current: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, marginBottom: 32 }}>
      {Array.from({ length: total }).map((_, i) => (
        <View
          key={i}
          style={{
            width: i === current ? 20 : 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: i <= current ? '#1c1917' : '#e7e5e4',
          }}
        />
      ))}
    </View>
  );
}

function HypothesisCard({ hyp }: { hyp: TasteHypothesis }) {
  return (
    <View style={{
      backgroundColor: '#fff',
      borderRadius: 14,
      padding: 16,
      marginBottom: 10,
      borderLeftWidth: 3,
      borderLeftColor: hyp.confidence === 'strong' ? '#1c1917' : '#d6d3d1',
      shadowColor: '#000',
      shadowOpacity: 0.04,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 1 },
      elevation: 1,
    }}>
      <Text style={{ fontSize: 14, color: '#1c1917', lineHeight: 20 }}>
        {hyp.statement}
      </Text>
      <Text style={{ fontSize: 11, color: '#a8a29e', marginTop: 6 }}>
        {hyp.confidence === 'strong' ? 'Strong signal' : 'Working hypothesis'}
      </Text>
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function DiagnosisScreen() {
  const router = useRouter();

  const [step, setStep]               = useState<Step>('loading');
  const [profile, setProfile]         = useState<TasteProfile | null>(null);
  const [hypotheses, setHypotheses]   = useState<TasteHypothesis[]>([]);
  const [questionIdx, setQuestionIdx] = useState(0);
  const [answers, setAnswers]         = useState<Record<string, string>>({});
  const [userId, setUserId]           = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!supabase) { setStep('hypotheses'); return; }
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.replace('/(auth)/login'); return; }

      setUserId(user.id);
      const tp = await computeTasteProfile(supabase, user.id);
      setProfile(tp);
      setHypotheses(generateHypotheses(tp));
      setStep('hypotheses');
    }
    load();
  }, []);

  async function handleAnswer(question: DiagnosisQuestion, keyIdx: 0 | 1) {
    const key = question.keys[keyIdx];
    const next = { ...answers, [question.id]: key };
    setAnswers(next);

    if (questionIdx < DIAGNOSIS_QUESTIONS.length - 1) {
      setQuestionIdx(i => i + 1);
    } else {
      // Persist all answers before showing the done screen
      if (supabase && userId) {
        await supabase
          .from('reader_preferences')
          .upsert(
            { user_id: userId, diagnosis_answers: next },
            { onConflict: 'user_id' }
          )
          .catch(() => null); // non-blocking — profile still shows even if save fails
      }
      setStep('done');
    }
  }

  // ── Loading ──────────────────────────────────────────────────────────────────

  if (step === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: '#faf9f7', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color="#1c1917" />
        <Text style={{ fontSize: 14, color: '#a8a29e', marginTop: 12 }}>
          Analysing your reading history…
        </Text>
      </View>
    );
  }

  // ── Hypotheses step ──────────────────────────────────────────────────────────

  if (step === 'hypotheses') {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: '#faf9f7' }}
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 56, paddingBottom: 60 }}
      >
        <BackButton onPress={() => router.back()} style={{ marginBottom: 24 }} />

        <Text style={{ fontSize: 28, fontWeight: '800', color: '#1c1917', letterSpacing: -0.5, marginBottom: 6 }}>
          What we think we know
        </Text>
        <Text style={{ fontSize: 14, color: '#78716c', lineHeight: 20, marginBottom: 28 }}>
          Based on your reading history, here are our working hypotheses about your taste.
          {'\n'}These are not facts — they update as you read more.
        </Text>

        {hypotheses.length === 0 ? (
          <View style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 20,
            marginBottom: 16,
          }}>
            <Text style={{ fontSize: 14, color: '#78716c', lineHeight: 20 }}>
              We don't have enough data to form strong hypotheses yet. Rate a few finished books or add taste tags to help us learn.
            </Text>
          </View>
        ) : (
          hypotheses.map(h => <HypothesisCard key={h.slug} hyp={h} />)
        )}

        <View style={{ marginTop: 8, marginBottom: 24, padding: 14, backgroundColor: '#f5f5f4', borderRadius: 12 }}>
          <Text style={{ fontSize: 12, color: '#78716c', lineHeight: 18 }}>
            Next, we'll ask you 5 quick questions to test these hypotheses and sharpen your profile.
          </Text>
        </View>

        <TouchableOpacity
          onPress={() => setStep('questions')}
          style={{
            backgroundColor: '#1c1917',
            borderRadius: 14,
            paddingVertical: 16,
            alignItems: 'center',
          }}
        >
          <Text style={{ fontSize: 15, fontWeight: '600', color: '#fff' }}>
            Answer 5 questions →
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => router.back()}
          style={{ marginTop: 16, alignItems: 'center', paddingVertical: 12 }}
        >
          <Text style={{ fontSize: 14, color: '#a8a29e' }}>Skip for now</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ── Questions step ────────────────────────────────────────────────────────────

  if (step === 'questions') {
    const question = DIAGNOSIS_QUESTIONS[questionIdx];
    return (
      <View style={{ flex: 1, backgroundColor: '#faf9f7', paddingHorizontal: 24, paddingTop: 56 }}>
        <ProgressDots total={DIAGNOSIS_QUESTIONS.length} current={questionIdx} />

        <Text style={{ fontSize: 11, fontWeight: '700', color: '#a8a29e', letterSpacing: 0.9, textTransform: 'uppercase', marginBottom: 16 }}>
          Question {questionIdx + 1} of {DIAGNOSIS_QUESTIONS.length}
        </Text>

        <Text style={{ fontSize: 22, fontWeight: '700', color: '#1c1917', lineHeight: 30, marginBottom: 36 }}>
          {question.text}
        </Text>

        <TouchableOpacity
          onPress={() => handleAnswer(question, 0)}
          style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 20,
            marginBottom: 12,
            borderWidth: 1,
            borderColor: '#e7e5e4',
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}
        >
          <Text style={{ fontSize: 16, color: '#1c1917', lineHeight: 22 }}>
            {question.options[0]}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => handleAnswer(question, 1)}
          style={{
            backgroundColor: '#fff',
            borderRadius: 14,
            padding: 20,
            marginBottom: 24,
            borderWidth: 1,
            borderColor: '#e7e5e4',
            shadowColor: '#000',
            shadowOpacity: 0.04,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 1 },
            elevation: 1,
          }}
        >
          <Text style={{ fontSize: 16, color: '#1c1917', lineHeight: 22 }}>
            {question.options[1]}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => {
            // Skip this question, advance
            if (questionIdx < DIAGNOSIS_QUESTIONS.length - 1) {
              setQuestionIdx(i => i + 1);
            } else {
              setStep('done');
            }
          }}
          style={{ alignItems: 'center', paddingVertical: 8 }}
        >
          <Text style={{ fontSize: 13, color: '#a8a29e' }}>Skip this question</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Done step ─────────────────────────────────────────────────────────────────

  const tier = profile?.tier ?? 0;
  const label = CONFIDENCE_LABELS[tier];
  const signalCount = profile?.strongSignalCount ?? 0;
  const nextAt = profile?.nextTierAt ?? 5;

  return (
    <View style={{ flex: 1, backgroundColor: '#faf9f7', paddingHorizontal: 24, paddingTop: 56 }}>
      <View style={{
        backgroundColor: '#fff',
        borderRadius: 20,
        padding: 28,
        marginBottom: 20,
        alignItems: 'center',
        shadowColor: '#000',
        shadowOpacity: 0.06,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 3 },
        elevation: 3,
      }}>
        <Text style={{ fontSize: 36, marginBottom: 16 }}>✓</Text>
        <Text style={{ fontSize: 20, fontWeight: '700', color: '#1c1917', textAlign: 'center', marginBottom: 8 }}>
          Profile updated
        </Text>
        <Text style={{ fontSize: 14, color: '#78716c', textAlign: 'center', lineHeight: 20 }}>
          {label}
        </Text>
      </View>

      {tier < 3 && (
        <View style={{
          backgroundColor: '#fff',
          borderRadius: 14,
          padding: 16,
          marginBottom: 16,
        }}>
          <Text style={{ fontSize: 12, fontWeight: '600', color: '#57534e', marginBottom: 8 }}>
            Signals collected
          </Text>
          <View style={{ height: 4, backgroundColor: '#e7e5e4', borderRadius: 2, overflow: 'hidden', marginBottom: 6 }}>
            <View style={{
              height: 4,
              width: `${Math.min(100, Math.round((signalCount / nextAt) * 100))}%`,
              backgroundColor: '#1c1917',
              borderRadius: 2,
            }} />
          </View>
          <Text style={{ fontSize: 12, color: '#a8a29e' }}>
            {signalCount} of {nextAt} signals to next tier
          </Text>
        </View>
      )}

      <TouchableOpacity
        onPress={() => router.replace('/(tabs)')}
        style={{
          backgroundColor: '#1c1917',
          borderRadius: 14,
          paddingVertical: 16,
          alignItems: 'center',
        }}
      >
        <Text style={{ fontSize: 15, fontWeight: '600', color: '#fff' }}>
          Go to Home
        </Text>
      </TouchableOpacity>
    </View>
  );
}
