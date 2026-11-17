// The in-memory task provider lives with the server (so the e2e server can register it); tests use it from here.
export { FakeProvider, fakeProvider, type FakeOptions } from '../../server/providers/fake/provider';
