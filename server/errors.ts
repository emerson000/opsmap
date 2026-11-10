/** Error names and machine codes diagnose failures without recording payloads or credentials. */
export function errorCode(error:unknown):string {
 if(!error||typeof error!=='object')return 'Unknown error';
 const value=error as {name?:unknown;code?:unknown;error?:unknown;cause?:{code?:unknown}};
 return [value.name,value.code,value.error,value.cause?.code].filter(x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(x)).join(' ')||'Unknown error';
}
