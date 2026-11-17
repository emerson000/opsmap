// The Vikunja adapter passes the provider contract, over the in-memory Vikunja.
import { FakeVikunja } from './fake-vikunja';
import { VikunjaProvider } from '../../../server/providers/vikunja';
import { providerContract } from '../provider-contract';

providerContract('vikunja over FakeVikunja', () => {
  const vk = new FakeVikunja();
  return { provider: new VikunjaProvider('https://todo.example', () => vk), token: 'tk_good_token', deleteRemote: async id => vk.deleteTask(Number(id)) };
});
