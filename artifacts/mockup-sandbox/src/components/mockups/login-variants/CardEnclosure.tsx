import React, { useState } from 'react';

export function CardEnclosure() {
  const [isLogin, setIsLogin] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setTimeout(() => setIsLoading(false), 1500);
  };

  return (
    <div className="flex flex-col min-h-screen bg-[#faf9f7] items-center justify-center sm:py-12">
      {/* Mobile container constraint */}
      <div className="w-full max-w-[390px] px-5 flex flex-col items-center">
        
        {/* The Card */}
        <div className="w-full bg-white rounded-2xl shadow-sm border border-[#f5f5f4] p-7">
          {/* Header */}
          <div className="flex flex-col items-center mb-6">
            <h1 className="text-[#1c1917] text-[26px] font-bold tracking-tight mb-1">
              readstack
            </h1>
            <p className="text-[#a8a29e] text-[13px]">
              Your reading, together.
            </p>
            
            {!isLogin && (
              <p className="text-[#d4a574] text-xs font-medium mt-3 bg-[#faf9f7] px-3 py-1.5 rounded-full">
                Import from Goodreads after signup
              </p>
            )}
          </div>

          {/* Mode Toggle */}
          <div className="flex p-1 bg-[#f5f5f4] rounded-lg mb-6">
            <button
              type="button"
              onClick={() => setIsLogin(true)}
              className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-all ${
                isLogin
                  ? 'bg-white text-[#1c1917] shadow-sm'
                  : 'text-[#78716c] hover:text-[#1c1917]'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => setIsLogin(false)}
              className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-all ${
                !isLogin
                  ? 'bg-white text-[#1c1917] shadow-sm'
                  : 'text-[#78716c] hover:text-[#1c1917]'
              }`}
            >
              Create Account
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {!isLogin && (
              <div className="flex gap-3">
                <div className="flex flex-col gap-1.5 flex-1">
                  <label className="text-xs font-medium text-[#57534e]">First Name</label>
                  <input
                    type="text"
                    placeholder="Jane"
                    className="w-full bg-transparent border border-[#e7e5e4] rounded-lg px-3 py-2 text-sm text-[#1c1917] placeholder:text-[#a8a29e] focus:outline-none focus:border-[#1c1917] focus:ring-1 focus:ring-[#1c1917] transition-colors"
                  />
                </div>
                <div className="flex flex-col gap-1.5 flex-1">
                  <label className="text-xs font-medium text-[#57534e]">Last Name</label>
                  <input
                    type="text"
                    placeholder="Austen"
                    className="w-full bg-transparent border border-[#e7e5e4] rounded-lg px-3 py-2 text-sm text-[#1c1917] placeholder:text-[#a8a29e] focus:outline-none focus:border-[#1c1917] focus:ring-1 focus:ring-[#1c1917] transition-colors"
                  />
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[#57534e]">Email</label>
              <input
                type="email"
                placeholder="jane@example.com"
                className="w-full bg-transparent border border-[#e7e5e4] rounded-lg px-3 py-2 text-sm text-[#1c1917] placeholder:text-[#a8a29e] focus:outline-none focus:border-[#1c1917] focus:ring-1 focus:ring-[#1c1917] transition-colors"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-[#57534e]">Password</label>
                {isLogin && (
                  <button type="button" className="text-[11px] font-medium text-[#a8a29e] hover:text-[#1c1917] transition-colors">
                    Forgot?
                  </button>
                )}
              </div>
              <input
                type="password"
                placeholder="••••••••"
                className="w-full bg-transparent border border-[#e7e5e4] rounded-lg px-3 py-2 text-sm text-[#1c1917] placeholder:text-[#a8a29e] focus:outline-none focus:border-[#1c1917] focus:ring-1 focus:ring-[#1c1917] transition-colors"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="mt-2 w-full bg-[#1c1917] hover:bg-black text-white rounded-lg py-2.5 text-sm font-medium transition-colors disabled:opacity-70 flex items-center justify-center"
            >
              {isLoading ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : isLogin ? (
                'Sign In'
              ) : (
                'Create Account'
              )}
            </button>
          </form>
        </div>

        {/* Footer */}
        <p className="mt-6 text-[11px] text-[#a8a29e] text-center max-w-[260px]">
          By {isLogin ? 'signing in' : 'creating an account'}, you agree to our Terms of Service and Privacy Policy.
        </p>

      </div>
    </div>
  );
}
