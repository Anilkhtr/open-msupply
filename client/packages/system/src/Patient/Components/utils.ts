import { useEffect, useState } from 'react';
import { SearchInputPatient } from '../utils';
import { usePatient } from '../api';
import { useDebouncedValue } from '@common/hooks';

const shouldSearch = (text: string) => text.length > 0;
type UseSearchPatientOptions = {
  showAllOnEmpty?: boolean;
};

const toSearchInputPatient = (
  patient: Pick<
    SearchInputPatient,
    'id' | 'name' | 'code' | 'isDeceased' | 'firstName' | 'lastName' | 'dateOfBirth'
  >
): SearchInputPatient => ({
  id: patient.id,
  name: patient.name,
  code: patient.code,
  isDeceased: patient.isDeceased,
  firstName: patient.firstName,
  lastName: patient.lastName,
  dateOfBirth: patient.dateOfBirth,
});

export const useSearchPatient = ({ showAllOnEmpty = false }: UseSearchPatientOptions = {}) => {
  const [searchText, setSearchText] = useState('');
  const {
    mutate: searchMutate,
    isLoading: isSearchLoading,
    data: searchData,
    isSuccess: isSearchSuccess,
  } = usePatient.utils.search();
  const {
    mutate: listAllMutate,
    isLoading: isListAllLoading,
    data: listAllData,
    isSuccess: isListAllSuccess,
  } = usePatient.document.listAll({ key: 'name', direction: 'asc', isDesc: false });

  const debouncedSearchText = useDebouncedValue(searchText, 500);

  const search = (value: string) => {
    setSearchText(value);
  };

  useEffect(() => {
    if (shouldSearch(debouncedSearchText)) {
      searchMutate({ identifier: debouncedSearchText });
      return;
    }

    if (showAllOnEmpty) {
      listAllMutate();
    }
  }, [debouncedSearchText, searchMutate, showAllOnEmpty, listAllMutate]);

  let patients: SearchInputPatient[] = [];
  let totalCount = 0;

  if (shouldSearch(debouncedSearchText) && searchData) {
    patients = searchData.nodes.map(node => toSearchInputPatient(node.patient));
    totalCount = searchData.totalCount ?? 0;
  } else if (showAllOnEmpty && listAllData) {
    patients = listAllData.nodes.map(node => toSearchInputPatient(node));
    totalCount = listAllData.totalCount ?? 0;
  }

  return {
    // From the user's POV, waiting for debounce and waiting for query result
    // are essentially the same thing, so show the same "loading" indicator
    isLoading:
      isSearchLoading ||
      isListAllLoading ||
      (searchText !== debouncedSearchText && shouldSearch(searchText)),
    patients,
    totalCount,
    search,
    isSuccess: isSearchSuccess || isListAllSuccess,
  };
};
