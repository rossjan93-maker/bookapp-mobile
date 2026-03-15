import React, { useState } from "react";
import { Mail, Lock, User, ArrowRight, Loader2 } from "lucide-react";

export function FormFirst() {
  const [isSignUp, setIsSignUp] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setTimeout(() => {
      setIsLoading(false);
    }, 1500);
  };

  return (
    <div className="flex justify-center items-center min-h-screen bg-[#faf9f7] font-sans">
      {/* Mobile Screen Container */}
      <div className="w-full max-w-[390px] h-[844px] bg-[#faf9f7] shadow-2xl overflow-hidden relative border border-[#e7e5e4] rounded-[40px] flex flex-col pt-12 pb-8 px-6">
        
        {/* Top Strip Identity */}
        <div className="flex flex-col mb-4">
          <h1 className="text-[18px] font-medium text-[#1c1917] tracking-tight">readstack</h1>
          <p className="text-[12px] text-[#a8a29e] mt-0.5">Your reading, together.</p>
        </div>

        {/* Form Container */}
        <div className="flex-1 flex flex-col">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            
            {/* Sign Up Fields */}
            {isSignUp && (
              <div className="flex gap-3">
                <div className="flex-1 relative">
                  <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none text-[#a8a29e]">
                    <User size={16} />
                  </div>
                  <input
                    type="text"
                    placeholder="First name"
                    value={formData.firstName}
                    onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                    className="w-full pl-9 pr-3 py-3 bg-white border border-[#e7e5e4] rounded-xl text-[14px] text-[#1c1917] placeholder:text-[#a8a29e] focus:outline-none focus:ring-2 focus:ring-[#d4a574]/30 focus:border-[#d4a574] transition-all"
                    required={isSignUp}
                  />
                </div>
                <div className="flex-1 relative">
                  <input
                    type="text"
                    placeholder="Last name"
                    value={formData.lastName}
                    onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                    className="w-full px-3 py-3 bg-white border border-[#e7e5e4] rounded-xl text-[14px] text-[#1c1917] placeholder:text-[#a8a29e] focus:outline-none focus:ring-2 focus:ring-[#d4a574]/30 focus:border-[#d4a574] transition-all"
                    required={isSignUp}
                  />
                </div>
              </div>
            )}

            {isSignUp && (
              <div className="bg-[#f5f5f4] rounded-lg px-3 py-2 border border-[#e7e5e4]">
                <p className="text-[12px] text-[#57534e]">
                  <span className="font-medium">Tip:</span> You can import your Goodreads library after creating your account.
                </p>
              </div>
            )}

            {/* Email Field */}
            <div className="relative">
              <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none text-[#a8a29e]">
                <Mail size={16} />
              </div>
              <input
                type="email"
                placeholder="Email address"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                className="w-full pl-9 pr-3 py-3 bg-white border border-[#e7e5e4] rounded-xl text-[14px] text-[#1c1917] placeholder:text-[#a8a29e] focus:outline-none focus:ring-2 focus:ring-[#d4a574]/30 focus:border-[#d4a574] transition-all"
                required
              />
            </div>

            {/* Password Field */}
            <div className="relative">
              <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none text-[#a8a29e]">
                <Lock size={16} />
              </div>
              <input
                type="password"
                placeholder="Password"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                className="w-full pl-9 pr-3 py-3 bg-white border border-[#e7e5e4] rounded-xl text-[14px] text-[#1c1917] placeholder:text-[#a8a29e] focus:outline-none focus:ring-2 focus:ring-[#d4a574]/30 focus:border-[#d4a574] transition-all"
                required
              />
            </div>

            {/* CTA Button */}
            <button
              type="submit"
              disabled={isLoading}
              className="w-full mt-2 bg-[#1c1917] text-[#faf9f7] font-medium py-3.5 rounded-xl text-[15px] flex items-center justify-center gap-2 hover:bg-[#1c1917]/90 active:scale-[0.98] transition-all disabled:opacity-70 disabled:active:scale-100"
            >
              {isLoading ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                isSignUp ? "Create Account" : "Sign In"
              )}
            </button>
          </form>

          {/* Empty Space / Breathing Room */}
          <div className="flex-1" />

          {/* Mode Toggle at Bottom */}
          <div className="flex justify-center pb-6">
            <button
              onClick={() => setIsSignUp(!isSignUp)}
              className="text-[13px] text-[#57534e] hover:text-[#1c1917] font-medium flex items-center gap-1 group transition-colors"
            >
              {isSignUp ? "Already have one? Sign in" : "New here? Create an account"}
              <ArrowRight size={14} className="group-hover:translate-x-0.5 transition-transform" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
