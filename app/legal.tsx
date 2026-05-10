import { ScrollView, Text, TouchableOpacity, View, Linking, Alert, Platform } from 'react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { SAGE_DEEP } from '../lib/tokens';
import { useScreenTopPadding } from '../lib/screenLayout';
import { BackButton } from '../components/BackButton';

// TODO(beta-launch): replace placeholder URLs with the final hosted policy
// pages before public release. They MUST be live & reachable for App Store review.
const PRIVACY_POLICY_URL = 'https://readstack.co/privacy';
const TERMS_OF_SERVICE_URL = 'https://readstack.co/terms';
const SUPPORT_EMAIL = 'hello@readstack.co';

async function openUrl(url: string, fallbackMessage: string) {
  try {
    const supported = await Linking.canOpenURL(url);
    if (!supported) {
      Alert.alert('Cannot open link', fallbackMessage);
      return;
    }
    await Linking.openURL(url);
  } catch {
    Alert.alert('Cannot open link', fallbackMessage);
  }
}

function buildSupportMailto(subject: string) {
  const version = Constants.expoConfig?.version ?? '?';
  const build =
    Platform.OS === 'ios'
      ? Constants.expoConfig?.ios?.buildNumber ?? '?'
      : String(Constants.expoConfig?.android?.versionCode ?? '?');
  const body = `\n\n— — —\nDiagnostic info (please keep):\nReadstack v${version} (${Platform.OS} build ${build})\n`;
  const params = new URLSearchParams({ subject, body });
  return `mailto:${SUPPORT_EMAIL}?${params.toString()}`;
}

function Row({
  title,
  subtitle,
  onPress,
  last,
}: {
  title: string;
  subtitle: string;
  onPress: () => void;
  last?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        paddingVertical: 14,
        paddingHorizontal: 14,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: '#f3eee8',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: '600', color: '#231f1b', marginBottom: 3 }}>
            {title}
          </Text>
          <Text style={{ fontSize: 12, color: '#9e958d', lineHeight: 18 }}>{subtitle}</Text>
        </View>
        <Text style={{ fontSize: 20, color: '#c4b5a5', marginLeft: 10 }}>›</Text>
      </View>
    </TouchableOpacity>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        fontSize: 12,
        fontWeight: '600',
        color: '#9e958d',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        marginBottom: 8,
        marginLeft: 4,
      }}
    >
      {children}
    </Text>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: '#fefcf9',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#ede9e4',
        marginBottom: 20,
      }}
    >
      {children}
    </View>
  );
}

export default function LegalScreen() {
  const router = useRouter();
  const topPad = useScreenTopPadding();
  const version = Constants.expoConfig?.version ?? '—';
  const build =
    Platform.OS === 'ios'
      ? Constants.expoConfig?.ios?.buildNumber ?? '—'
      : String(Constants.expoConfig?.android?.versionCode ?? '—');

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: '#fbf8f3' }}
      contentContainerStyle={{ paddingTop: topPad, paddingHorizontal: 16, paddingBottom: 40 }}
    >
      <BackButton onPress={() => router.back()} style={{ marginBottom: 8 }} />
      <Text style={{ fontSize: 28, fontWeight: '700', color: '#231f1b', marginTop: 8, marginBottom: 4 }}>
        Help & Legal
      </Text>
      <Text style={{ fontSize: 13, color: '#9e958d', marginBottom: 20 }}>
        Get in touch, report problems, or read our policies.
      </Text>

      <SectionLabel>Support</SectionLabel>
      <Card>
        <Row
          title="Contact support"
          subtitle="Email us with a question or need"
          onPress={() =>
            openUrl(buildSupportMailto('Readstack support'), `Email us at ${SUPPORT_EMAIL}`)
          }
        />
        <Row
          title="Report a bug"
          subtitle="Something broken? Tell us what happened"
          onPress={() =>
            openUrl(buildSupportMailto('Readstack bug report'), `Email us at ${SUPPORT_EMAIL}`)
          }
          last
        />
      </Card>

      <SectionLabel>Legal</SectionLabel>
      <Card>
        <Row
          title="Privacy policy"
          subtitle="How we handle your reading data"
          onPress={() => openUrl(PRIVACY_POLICY_URL, `Visit ${PRIVACY_POLICY_URL}`)}
        />
        <Row
          title="Terms of service"
          subtitle="The rules of using Readstack"
          onPress={() => openUrl(TERMS_OF_SERVICE_URL, `Visit ${TERMS_OF_SERVICE_URL}`)}
          last
        />
      </Card>

      <SectionLabel>About</SectionLabel>
      <View
        style={{
          backgroundColor: '#fefcf9',
          borderRadius: 12,
          borderWidth: 1,
          borderColor: '#ede9e4',
          padding: 14,
        }}
      >
        <Text style={{ fontSize: 13, color: '#57534e', lineHeight: 20, marginBottom: 8 }}>
          Readstack helps you discover, track, and share book recommendations.
        </Text>
        <Text style={{ fontSize: 12, color: SAGE_DEEP }}>
          Version {version} (build {build})
        </Text>
        <Text style={{ fontSize: 11, color: '#c4b5a5', marginTop: 8 }}>
          Book metadata from Open Library and Google Books.
        </Text>
      </View>
    </ScrollView>
  );
}
