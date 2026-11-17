/** Bounded token bucket; callers retain one bucket per connection or authenticated token. */
export class Bucket {
 private tokens:number;private at=Date.now();
 constructor(private rate:number,private capacity=rate*2){this.tokens=capacity;}
 private refill():void {const now=Date.now();this.tokens=Math.min(this.capacity,this.tokens+(now-this.at)*this.rate/1000);this.at=now;}
 take():boolean {this.refill();if(this.tokens<1)return false;this.tokens--;return true;}
 /** No token left now; takes none. */
 empty():boolean {this.refill();return this.tokens<1;}
}
/** The request body as text, refusing more than `limit` bytes however the client declares its length. */
export async function boundedText(request:Request,limit:number):Promise<string> {
  const reader=request.body?.getReader();if(!reader)return '';
  let size=0;const chunks:Uint8Array[]=[];
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('Request too large');}chunks.push(value);}}finally{reader.releaseLock();}
  return Buffer.concat(chunks).toString('utf8');
}
