import React from 'react';

export const LogoWithoutText = (props: React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Manifex" {...props}>
    <rect width="64" height="64" rx="12" fill="#0a0a0a" />
    <path
      d="M16 45V19h6.2L32 35.2 41.8 19H48v26h-5.8V29.4L34.4 42h-4.8l-7.8-12.6V45H16Z"
      fill="#fff"
    />
  </svg>
);
