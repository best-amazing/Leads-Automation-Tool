import React, { useState } from 'react';
import { Header, PageContainer } from '@/components/layout';
import { FilterForm } from '@/components/filters';
import { useFilter } from '@/hooks';

export const FiltersPage: React.FC = () => {
  const { filter, loading, error, updateFilter } = useFilter();
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (filterData: any) => {
    setIsSaving(true);
    try {
      await updateFilter(filterData);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <PageContainer>
      <Header
        title="Filters"
        subtitle="Configure your active search filter"
      />

      <div className="p-8">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded mb-4">
            Error: {error.message}
          </div>
        )}

        <FilterForm
          initialFilter={filter}
          onSubmit={handleSubmit}
          loading={isSaving || loading}
        />
      </div>
    </PageContainer>
  );
};
