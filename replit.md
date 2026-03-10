# bookapp-mobile

A React Native book tracking app built with Expo, targeting web (and optionally mobile).

## Architecture

- **Framework**: Expo SDK 55 with Expo Router (file-based routing)
- **Language**: TypeScript
- **Platform**: React Native Web (runs in browser via Metro bundler)
- **Backend**: Supabase (planned for future phases — not yet configured)

## Project Structure

```
app/
  _layout.tsx          - Root layout
  (auth)/              - Auth screens (login)
  (tabs)/              - Tab navigation (Home, Search, Library, Notes, Profile)
  book/[id].tsx        - Book detail screen
  settings/import.tsx  - Import settings
  user-book/[id].tsx   - User book detail screen
lib/                   - Shared utilities
components/            - Shared components
supabase/              - Supabase config and migrations (future)
docs/                  - Architecture docs, ADRs, product specs
```

## Development

Run the app:
```bash
npm run web
```

This starts Metro bundler with Expo for web on port 5000 using `--host lan` (binds to all interfaces, required for Replit preview).

## Key Configuration

- **Port**: 5000 (required for Replit webview)
- **Host**: `lan` mode (Expo's way to bind to 0.0.0.0, needed for Replit proxy)
- **Babel**: Uses `babel-preset-expo` only (expo-router/babel plugin removed as deprecated in SDK 50+)

## Package Versions

The original `package.json` used future SDK version numbers that weren't published yet. Updated to use SDK 55 compatible versions:
- `expo@~55.0.5`
- `expo-router@~55.0.4`
- `react@19.2.0` / `react-dom@19.2.0`
- `react-native@0.83.2`
- `react-native-web@~0.21.2`
- `@expo/metro-runtime@~55.0.6`

## Environment Variables

See `.env.example` — reserved for future Supabase configuration.

## Deployment

Configured for autoscale deployment via `npm run web`.
