/** Bounded token bucket; callers retain one bucket per connection or authenticated token. */
export class Bucket {
 private tokens:number;private at=Date.now();
 constructor(private rate:number,private capacity=rate*2){this.tokens=capacity;}
 take():boolean {const now=Date.now();this.tokens=Math.min(this.capacity,this.tokens+(now-this.at)*this.rate/1000);this.at=now;if(this.tokens<1)return false;this.tokens--;return true;}
}
