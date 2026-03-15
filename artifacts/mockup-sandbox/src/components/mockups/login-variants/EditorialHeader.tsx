import React, { useState } from 'react';

export function EditorialHeader() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  
  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100 p-4">
      <div className="w-full max-w-[390px] h-[844px] bg-[#faf9f7] rounded-[40px] shadow-2xl overflow-hidden relative flex flex-col font-sans">
        
        {/* Top Zone - ~40% height */}
        <div className="flex-none h-[40%] flex flex-col items-center justify-center px-8 relative">
          <h1 className="text-[52px] font-black tracking-tight text-[#1c1917] leading-none mb-4">
            readstack
          </h1>
          <p className="text-[#57534e] text-lg font-medium tracking-wide">
            Your reading, together.
          </p>
          
          {mode === 'signup' && (
            <p className="absolute bottom-6 text-[#78716c] text-xs italic">
              Connect your Goodreads later to import your history.
            </p>
          )}
        </div>

        {/* Separator */}
        <div className="w-full h-px bg-[#e7e5e4]" />

        {/* Bottom Zone */}
        <div className="flex-1 flex flex-col px-8 pt-8 pb-10">
          
          {/* Segmented Control */}
          <div className="flex bg-[#e7e5e4]/50 p-1 rounded-full mb-8 relative">
            <button
              onClick={() => setMode('signin')}
              className={`flex-1 py-2 text-sm font-semibold rounded-full transition-all duration-300 z-10 ${
                mode === 'signin' 
                  ? 'bg-white text-[#1c1917] shadow-sm' 
                  : 'text-[#78716c] hover:text-[#1c1917]'
              }`}
            >
              Sign In
            </button>
            <button
              onClick={() => setMode('signup')}
              className={`flex-1 py-2 text-sm font-semibold rounded-full transition-all duration-300 z-10 ${
                mode === 'signup' 
                  ? 'bg-white text-[#1c1917] shadow-sm' 
                  : 'text-[#78716c] hover:text-[#1c1917]'
              }`}
            >
              Create Account
            </button>
          </div>

          {/* Form */}
          <div className="flex flex-col gap-4 flex-1">
            {mode === 'signup' && (
              <div className="flex gap-3">
                <input
                  type="text"
                  placeholder="First name"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className="w-1/2 bg-white border border-[#e7e5e4] rounded-xl px-4 py-3.5 text-[#1c1917] placeholder-[#a8a29e] focus:outline-none focus:ring-2 focus:ring-[#1c1917]/10 focus:border-[#1c1917] transition-all"
                />
                <input
                  type="text"
                  placeholder="Last name"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className="w-1/2 bg-white border border-[#e7e5e4] rounded-xl px-4 py-3.5 text-[#1c1917] placeholder-[#a8a29e] focus:outline-none focus:ring-2 focus:ring-[#1c1917]/10 focus:border-[#1c1917] transition-all"
                />
              </div>
            )}
            
            <input
              type="email"
              placeholder="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-white border border-[#e7e5e4] rounded-xl px-4 py-3.5 text-[#1c1917] placeholder-[#a8a29e] focus:outline-none focus:ring-2 focus:ring-[#1c1917]/10 focus:border-[#1c1917] transition-all"
            />
            
            <div className="relative">
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-white border border-[#e7e5e4] rounded-xl px-4 py-3.5 text-[#1c1917] placeholder-[#a8a29e] focus:outline-none focus:ring-2 focus:ring-[#1c1917]/10 focus:border-[#1c1917] transition-all"
              />
              {mode === 'signin' && (
                <button className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-semibold text-[#78716c] hover:text-[#1c1917]">
                  Forgot?
                </button>
              )}
            </div>
          </div>

          {/* CTA */}
          <div className="mt-auto pt-6">
            <button className="w-full bg-[#1c1917] text-white font-semibold py-4 rounded-xl shadow-lg shadow-[#1c1917]/20 active:scale-[0.98] transition-all flex items-center justify-center gap-2">
              {mode === 'signin' ? 'Sign In' : 'Create Account'}
            </button>
          </div>
          
        </div>
      </div>
    </div>
  );
}
