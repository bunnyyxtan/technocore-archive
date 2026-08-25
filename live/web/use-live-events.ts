import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetLiveArchiveStatusQueryKey,
  getGetLiveRecentRecordsQueryKey,
  getGetLiveDidQueryKey
} from '@workspace/api-client-react';

export function useLiveEvents(activeDid: string) {
  const queryClient = useQueryClient();
  const [esStatus, setEsStatus] = useState<'connecting' | 'live' | 'disconnected'>('connecting');

  useEffect(() => {
    let es: EventSource;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      setEsStatus('connecting');
      es = new EventSource('/api/live/events');

      es.onopen = () => {
        setEsStatus('live');
      };

      const invalidateLiveQueries = () => {
        // Server sends events when new records are durably inserted
        queryClient.invalidateQueries({ queryKey: getGetLiveArchiveStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetLiveRecentRecordsQueryKey() });
        if (activeDid && activeDid.startsWith('did:key:z')) {
          queryClient.invalidateQueries({ queryKey: getGetLiveDidQueryKey(activeDid) });
        }
      };
      es.addEventListener('capture', invalidateLiveQueries);

      es.onerror = () => {
        setEsStatus('disconnected');
        es.close();
        reconnectTimeout = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      clearTimeout(reconnectTimeout);
      if (es) es.close();
    };
  }, [queryClient, activeDid]);

  return esStatus;
}