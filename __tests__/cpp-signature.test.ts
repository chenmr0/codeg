import { describe, expect, it } from 'vitest';
import {
  cppCallableParametersMatch,
  cppCallableOwnersMatch,
  cppParameterKey,
  cppParameterKeysMatch,
} from '../src/resolution/cpp-signature';

const callable = (name: string, signature: string) => ({ name, signature });

describe('C++ callable parameter matching', () => {
  it('ignores top-level default arguments and parameter names', () => {
    const declaration = callable(
      'send',
      'int send(const ObDtlMsg &msg, int64_t timeout_ts = 0, bool is_eof = false)',
    );
    const definition = callable(
      'send',
      'int ObDtlChannel::send(const ObDtlMsg &packet, int64_t deadline, bool eof)',
    );

    expect(cppParameterKey(declaration)).toBe('const ObDtlMsg & , int64_t , bool');
    expect(cppCallableParametersMatch(declaration, definition)).toBe(true);
  });

  it('tolerates qualified versus unqualified parameter types', () => {
    const declaration = callable(
      'get_row',
      'int get_row(ObVirtualChannelInfo &info, common::ObNewRow *&row)',
    );
    const definition = callable(
      'get_row',
      'int ObAllVirtualDtlChannel::get_row(ObVirtualChannelInfo &channel, ObNewRow *&result)',
    );

    expect(cppCallableParametersMatch(declaration, definition)).toBe(true);
    expect(cppParameterKeysMatch('left::Row*', 'right::Row*')).toBe(false);
  });

  it('preserves keyword/type boundaries before comparing qualified types', () => {
    const declaration = callable(
      'make_channel',
      'int make_channel(const uint64_t tenant_id, const common::ObAddr &addr)',
    );
    const definition = callable(
      'make_channel',
      'int ObDtlChannelGroup::make_channel(const uint64_t tenant, const ObAddr &address)',
    );

    expect(cppParameterKey(declaration)).toBe('const uint64_t , const common::ObAddr &');
    expect(cppCallableParametersMatch(declaration, definition)).toBe(true);

    expect(cppCallableParametersMatch(
      callable(
        'ObDtlBasicChannel',
        'ObDtlBasicChannel(const uint64_t tenant_id, const common::ObAddr &peer)',
      ),
      callable(
        'ObDtlBasicChannel',
        'ObDtlBasicChannel::ObDtlBasicChannel(const uint64_t tenant, const ObAddr &address)',
      ),
    )).toBe(true);
  });

  it('ignores pointer/reference parameter names inside nested callable types', () => {
    const declaration = callable(
      'send1',
      'int send1(std::function<int(const ObDtlLinkedBuffer &buffer)> &proc, int64_t timeout)',
    );
    const definition = callable(
      'send1',
      'int Channel::send1(std::function<int(const ObDtlLinkedBuffer &)> &callback, int64_t deadline)',
    );

    expect(cppCallableParametersMatch(declaration, definition)).toBe(true);
  });

  it('keeps genuinely different overloads distinct', () => {
    expect(cppCallableParametersMatch(
      callable('push', 'int push()'),
      callable('push', 'int Channel::push(Buffer *buffer)'),
    )).toBe(false);
    expect(cppCallableParametersMatch(
      callable('send', 'int send(const Buffer &buffer)'),
      callable('send', 'int Channel::send(Buffer *buffer)'),
    )).toBe(false);
    expect(cppCallableParametersMatch(
      callable('send', 'int send(const LeftType)'),
      callable('send', 'int Channel::send(const RightType)'),
    )).toBe(false);
  });

  it('accepts omitted owner qualification but rejects different namespaces', () => {
    expect(cppCallableOwnersMatch(
      { qualifiedName: 'oceanbase::dtl::Channel::send' },
      { qualifiedName: 'Channel::send' },
    )).toBe(true);
    expect(cppCallableOwnersMatch(
      { qualifiedName: 'left::Channel::send' },
      { qualifiedName: 'right::Channel::send' },
    )).toBe(false);
    expect(cppCallableOwnersMatch(
      { qualifiedName: 'left::Channel::send' },
      { qualifiedName: 'Left::Channel::send' },
    )).toBe(false);
  });
});
