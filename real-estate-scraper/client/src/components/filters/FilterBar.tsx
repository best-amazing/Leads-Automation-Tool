import React from 'react';
import { AVAILABLE_SOURCES } from '@/services/types';

interface FilterBarProps {
  minPrice: string;
  maxPrice: string;
  source: string;
  onMinPriceChange: (value: string) => void;
  onMaxPriceChange: (value: string) => void;
  onSourceChange: (value: string) => void;
  onApply: () => void;
  disabled?: boolean;
}

export const FilterBar: React.FC<FilterBarProps> = ({
  minPrice,
  maxPrice,
  source,
  onMinPriceChange,
  onMaxPriceChange,
  onSourceChange,
  onApply,
  disabled = false,
}) => {
  return (
    <div className="bg-white shadow p-4 mb-6">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 items-end">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Min Price</label>
          <input
            type="number"
            value={minPrice}
            onChange={(e) => onMinPriceChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="Min price"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Max Price</label>
          <input
            type="number"
            value={maxPrice}
            onChange={(e) => onMaxPriceChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            placeholder="Max price"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Source</label>
          <select
            value={source}
            onChange={(e) => onSourceChange(e.target.value)}
            className="w-full px-3 pr-8 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          >
            {AVAILABLE_SOURCES.map((sourceOption) => (
              <option key={sourceOption.value} value={sourceOption.value}>
                {sourceOption.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center">
          <button
            type="button"
            onClick={onApply}
            disabled={disabled}
            className="w-full px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Apply Filter
          </button>
        </div>
      </div>
    </div>
  );
};
